"""
Basic tests for ML Service API
"""
import pytest
import json
from app import app

@pytest.fixture
def client():
    """Create test client"""
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

def test_score_endpoint_valid_event(client):
    """Test scoring a valid GitHub event"""
    test_event = {
        'id': 'test-123',
        'type': 'PushEvent',
        'repo': {'name': 'test/repo'},
        'actor': {'login': 'testuser'},
        'created_at': '2026-01-30T12:00:00Z',
        'payload': {
            'ref': 'refs/heads/main',
            'forced': True
        }
    }

    response = client.post(
        '/score',
        data=json.dumps(test_event),
        content_type='application/json'
    )

    assert response.status_code == 200
    data = json.loads(response.data)

    # Check response structure
    assert 'event_id' in data
    assert 'score' in data
    assert 'prediction' in data
    assert 'is_anomalous' in data
    assert 'features' in data

    # Check types
    assert isinstance(data['score'], (int, float))
    assert isinstance(data['prediction'], int)
    assert isinstance(data['is_anomalous'], bool)
    assert isinstance(data['features'], dict)

    # Check values are reasonable
    assert 0 <= data['score'] <= 1
    assert data['prediction'] in [0, 1]

def test_score_endpoint_missing_data(client):
    """Test scoring with missing data returns error"""
    response = client.post(
        '/score',
        data=json.dumps({}),
        content_type='application/json'
    )

    # Missing event ID should return 400
    assert response.status_code == 400

def test_score_endpoint_force_push_detection(client):
    """Test that force push to main is detected as high risk"""
    force_push_event = {
        'id': 'force-push-123',
        'type': 'PushEvent',
        'repo': {'name': 'critical/repo'},
        'actor': {'login': 'attacker'},
        'created_at': '2026-01-30T12:00:00Z',
        'payload': {
            'ref': 'refs/heads/main',
            'forced': True
        }
    }

    response = client.post(
        '/score',
        data=json.dumps(force_push_event),
        content_type='application/json'
    )

    assert response.status_code == 200
    data = json.loads(response.data)

    # Force push to main should have high score
    assert data['score'] > 0.5  # Should be risky
    assert 'force_push_to_main' in data['features']
    assert data['features']['force_push_to_main'] == 1.0

def test_score_endpoint_normal_event(client):
    """Test that normal events score low"""
    normal_event = {
        'id': 'normal-123',
        'type': 'PushEvent',
        'repo': {'name': 'project/repo'},
        'actor': {'login': 'developer'},
        'created_at': '2026-01-30T12:00:00Z',
        'payload': {
            'ref': 'refs/heads/feature-branch',
            'forced': False
        }
    }

    response = client.post(
        '/score',
        data=json.dumps(normal_event),
        content_type='application/json'
    )

    assert response.status_code == 200
    data = json.loads(response.data)

    # Normal event should have lower score
    assert 'force_push_to_main' in data['features']
    assert data['features']['force_push_to_main'] == 0.0
    assert data['features']['is_main_branch'] == 0.0

def test_code_quality_endpoint(client):
    """Test code quality scoring"""
    pr_event = {
        'id': 'pr-123',
        'type': 'PullRequestEvent',
        'repo': {'name': 'test/repo'},
        'actor': {'login': 'dev'},
        'created_at': '2026-01-30T12:00:00Z',
        'payload': {
            'action': 'opened',
            'pull_request': {
                'title': 'fix',
                'body': '',
                'additions': 500,
                'deletions': 100
            }
        }
    }

    response = client.post(
        '/score/code-quality',
        data=json.dumps(pr_event),
        content_type='application/json'
    )

    assert response.status_code == 200
    data = json.loads(response.data)

    # Check response structure
    assert 'event_id' in data
    assert 'score' in data
    assert 'prediction' in data
    assert 'is_good_practice' in data

    # Check types and ranges
    assert 0 <= data['score'] <= 1
    assert data['prediction'] in [0, 1]

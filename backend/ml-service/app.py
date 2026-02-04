from flask import Flask, request, jsonify
from feature_extractor import FeatureExtractor
from online_learner import OnlineLearner
from code_quality_extractor import CodeQualityExtractor
import os

app = Flask(__name__)

# Initialize security model
feature_extractor = FeatureExtractor()
learner = OnlineLearner(model_path='model.pkl')

# Initialize code quality model
code_quality_extractor = CodeQualityExtractor()
code_quality_learner = OnlineLearner(
    model_path='code_quality_model.pkl',
    metrics_path='code_quality_metrics.pkl'
)

ANOMALY_THRESHOLD = float(os.getenv('ANOMALY_THRESHOLD', '0.6'))
CODE_QUALITY_THRESHOLD = float(os.getenv('CODE_QUALITY_THRESHOLD', '0.20'))

@app.route('/score', methods=['POST'])
def score_event():
    """
    Score a single GitHub event.

    Request body: {
        event: GitHub event JSON (required),
        repo_context: Repo context from GraphQL (optional)
    }
    Response: { event_id, score, is_anomalous, features }
    """
    try:
        data = request.json

        if 'id' in data:
            event = data
            repo_context = None
        else:
            event = data.get('event')
            repo_context = data.get('repo_context')

        if not event or 'id' not in event:
            return jsonify({'error': 'Invalid event format'}), 400

        event_id = str(event['id'])

        features = feature_extractor.extract_features(event)

        if repo_context:
            context_features = _extract_repo_context_features(repo_context, event.get('type', ''))
            features.update(context_features)

        score, prediction = learner.predict(event_id, features)

        is_anomalous = score >= ANOMALY_THRESHOLD

        result = {
            'event_id': event_id,
            'score': score,
            'prediction': prediction,
            'is_anomalous': is_anomalous,
            'features': features,
            'event_type': event.get('type'),
            'repo': event.get('repo', {}).get('name'),
            'actor': event.get('actor', {}).get('login')
        }

        if is_anomalous:
            print(f"🚨 ANOMALY DETECTED (score={score:.2f}): {event.get('type')} on {event.get('repo', {}).get('name')}")

        return jsonify(result), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/score/code-quality', methods=['POST'])
def score_code_quality():
    """
    Score code quality/practices for a GitHub event.

    Request body: {
        event: GitHub event JSON (required),
        diff_data: Optional diff analysis (code_quality_score, has_test_files, etc.)
    }
    Response: { event_id, score, is_good_practice, features }
    """
    try:
        data = request.json

        if 'id' in data:
            event = data
            diff_data = None
        else:
            event = data.get('event')
            diff_data = data.get('diff_data')

        if not event or 'id' not in event:
            return jsonify({'error': 'Invalid event format'}), 400

        event_id = str(event['id'])

        features = code_quality_extractor.extract_features(event, diff_data)

        score, prediction = code_quality_learner.predict(event_id, features)

        is_good_practice = score >= CODE_QUALITY_THRESHOLD

        result = {
            'event_id': event_id,
            'score': score,
            'prediction': prediction,
            'is_good_practice': is_good_practice,
            'features': features,
            'event_type': event.get('type'),
            'repo': event.get('repo', {}).get('name'),
            'actor': event.get('actor', {}).get('login')
        }

        return jsonify(result), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500

def _extract_repo_context_features(repo_context: dict, event_type: str) -> dict:
    """
    Extract features from repo context (GraphQL data)
    These feed into River's anomaly detection
    """
    features = {}

    metadata = repo_context.get('metadata', {})
    security = repo_context.get('security', {})
    activity = repo_context.get('activity', {})
    checks = repo_context.get('checks', {})

    features['repo_age_days'] = float(metadata.get('age_days', 0))
    features['repo_is_young'] = 1.0 if metadata.get('age_days', 999) < 30 else 0.0
    features['repo_stars'] = float(metadata.get('stars', 0))
    features['repo_is_unpopular'] = 1.0 if metadata.get('stars', 0) < 10 else 0.0

    features['repo_no_branch_protection'] = 0.0 if security.get('hasBranchProtection', True) else 1.0
    features['repo_is_archived'] = 1.0 if metadata.get('isArchived', False) else 0.0
    features['repo_vuln_alerts_enabled'] = 1.0 if security.get('vulnerabilityAlertsEnabled', False) else 0.0

    features['repo_unique_contributors'] = float(activity.get('uniqueContributors', 0))
    features['repo_low_contributor_count'] = 1.0 if activity.get('uniqueContributors', 99) < 3 else 0.0
    features['repo_recent_commit_count'] = float(activity.get('recentCommitCount', 0))

    if checks:
        features['repo_check_failure_rate'] = float(checks.get('failureRate', 0))
        features['repo_high_check_failures'] = 1.0 if checks.get('failureRate', 0) > 0.5 else 0.0

    features['repo_young_unprotected'] = features['repo_is_young'] * features['repo_no_branch_protection']

    features['repo_archived_active'] = features['repo_is_archived']

    if activity.get('uniqueContributors', 1) > 0:
        activity_per_contributor = activity.get('recentCommitCount', 0) / activity.get('uniqueContributors', 1)
        features['repo_activity_per_contributor'] = min(activity_per_contributor, 100.0)
    else:
        features['repo_activity_per_contributor'] = 0.0

    return features

if __name__ == '__main__':
    port = int(os.getenv('ML_PORT', '5001'))
    print(f"Starting ML Service on port {port}")
    print(f"Anomaly threshold: {ANOMALY_THRESHOLD}")
    app.run(host='0.0.0.0', port=port, debug=True)

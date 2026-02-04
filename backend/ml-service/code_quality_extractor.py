from datetime import datetime
from typing import Dict, Any, Optional
import re

class CodeQualityExtractor:
    """
    Extracts code quality/practice features from GitHub events.
    Separate from security features - focuses on development practices.
    """

    def __init__(self):
        # Track patterns over time
        self.repo_pr_sizes = {}  # repo -> list of PR sizes
        self.actor_commit_patterns = {}  # actor -> stats

    def extract_features(self, event: Dict[str, Any], diff_data: Optional[Dict] = None) -> Dict[str, float]:
        """
        Extract code quality features from event.

        Args:
            event: GitHub event
            diff_data: Optional diff/PR data fetched separately
        """
        event_type = event.get('type', '')
        payload = event.get('payload', {})
        repo_name = event.get('repo', {}).get('name', '')
        actor = event.get('actor', {}).get('login', '')

        features = {}

        pr_context = event.get('_pr_context')
        commit_context = event.get('_commit_context')

        if pr_context or commit_context:
            context_features = self.extract_pr_commit_features(pr_context, commit_context)
            features.update(context_features)

        if event_type == 'PullRequestEvent' and payload.get('pull_request'):
            pr = payload['pull_request']
            features['pr_lines_added'] = float(pr.get('additions', 0))
            features['pr_lines_deleted'] = float(pr.get('deletions', 0))
            features['pr_total_lines'] = features['pr_lines_added'] + features['pr_lines_deleted']
            features['pr_files_changed'] = float(pr.get('changed_files', 0))
            features['pr_commits'] = float(pr.get('commits', 0))

            # Size categories
            total = features['pr_total_lines']
            features['pr_is_tiny'] = 1.0 if total < 10 else 0.0
            features['pr_is_small'] = 1.0 if 10 <= total < 100 else 0.0
            features['pr_is_medium'] = 1.0 if 100 <= total < 500 else 0.0
            features['pr_is_large'] = 1.0 if total >= 500 else 0.0

            if features['pr_lines_added'] > 0:
                features['pr_churn_ratio'] = features['pr_lines_deleted'] / features['pr_lines_added']
            else:
                features['pr_churn_ratio'] = 0.0

        elif event_type == 'PushEvent':
            # Note: Events API doesn't include commits array, only head/before SHAs
            # We can't extract commit count or messages from Events API
            # Would need separate API call to get commit details
            features['push_has_sha'] = 1.0 if payload.get('head') else 0.0

        ref = payload.get('ref', '')
        features['is_feature_branch'] = 0.0 if ref in ['refs/heads/main', 'refs/heads/master'] else 1.0

        branch_name = ref.replace('refs/heads/', '') if ref else ''
        bad_names = ['test', 'temp', 'tmp', 'asdf', 'foo', 'bar', 'branch']
        features['branch_name_is_good'] = 0.0 if any(bad in branch_name.lower() for bad in bad_names) else 1.0

        if event_type == 'PullRequestEvent':
            pr = payload.get('pull_request', {})
            action = payload.get('action', '')

            features['pr_is_merged'] = 1.0 if action == 'closed' and pr.get('merged') else 0.0
            features['pr_has_reviewers'] = 1.0 if pr.get('requested_reviewers') or pr.get('requested_teams') else 0.0

            pr_author = pr.get('user', {}).get('login', '')
            merged_by = pr.get('merged_by', {}).get('login', '') if pr.get('merged_by') else ''
            features['pr_self_merged'] = 1.0 if (pr_author == merged_by and merged_by) else 0.0

        if diff_data:
            features['has_test_files'] = 1.0 if diff_data.get('has_test_files', False) else 0.0
            features['has_readme_changes'] = 1.0 if diff_data.get('has_readme_changes', False) else 0.0

        features['is_bot_actor'] = 1.0 if '[bot]' in actor.lower() else 0.0

        default_features = {
            'pr_lines_added': 0.0,
            'pr_lines_deleted': 0.0,
            'pr_total_lines': 0.0,
            'pr_files_changed': 0.0,
            'pr_commits': 0.0,
            'pr_is_tiny': 0.0,
            'pr_is_small': 0.0,
            'pr_is_medium': 0.0,
            'pr_is_large': 0.0,
            'pr_churn_ratio': 0.0,
            'push_has_sha': 0.0,
            'is_feature_branch': 0.0,
            'branch_name_is_good': 1.0,
            'pr_is_merged': 0.0,
            'pr_has_reviewers': 0.0,
            'pr_self_merged': 0.0,
            'has_test_files': 0.0,
            'has_readme_changes': 0.0,
            'is_bot_actor': 0.0,
            'has_commit_message': 0.0,
            'commit_message_length': 0.0,
            'commit_message_word_count': 0.0,
            'has_vague_message': 0.0,
            'has_conventional_format': 0.0,
            'has_description_body': 0.0,
            'has_pr_title': 0.0,
            'pr_title_length': 0.0,
            'has_pr_description': 0.0,
            'pr_description_length': 0.0,
            'pr_description_word_count': 0.0,
            'num_test_files': 0.0,
            'num_src_files': 0.0,
            'num_config_files': 0.0,
            'num_doc_files': 0.0,
            'modifies_license': 0.0,
            'modifies_package_lock': 0.0,
            'file_type_diversity': 0.0,
            'mixing_src_and_docs': 0.0,
            'mixing_code_and_deps': 0.0,
            'test_to_src_ratio': 0.0,
            'adds_code_without_tests': 0.0,
            'pr_review_count': 0.0,
            'pr_comment_count': 0.0,
            'pr_has_reviews': 0.0,
            'pr_merged_quickly': 0.0,
        }

        for key, default_val in default_features.items():
            if key not in features:
                features[key] = default_val

        return features

    def extract_pr_commit_features(self, pr_context: Optional[Dict] = None, commit_context: Optional[Dict] = None) -> Dict[str, float]:
        """
        Extract features from PR/commit GraphQL context.
        These are the rich features that correlate with Claude's scoring.

        Args:
            pr_context: PR data from GraphQL (title, body, commits, files, etc.)
            commit_context: Commit data from GraphQL (message, author, etc.)
        """
        features = {}

        commit_messages = []

        if pr_context and 'commits' in pr_context:
            commit_messages = [c.get('message', '') for c in pr_context['commits']]
        elif commit_context:
            commit_messages = [commit_context.get('message', '')]

        if commit_messages:
            all_messages = ' '.join(commit_messages)
            first_message = commit_messages[0] if commit_messages else ''

            features['has_commit_message'] = 1.0 if any(msg.strip() for msg in commit_messages) else 0.0
            features['commit_message_length'] = float(len(first_message))
            features['commit_message_word_count'] = float(len(first_message.split()))

            vague_patterns = ['fix', 'update', 'wip', 'test', 'changes', 'stuff']
            is_vague = any(
                first_message.lower().strip() == pattern or
                first_message.lower().strip() == f'{pattern}.'
                for pattern in vague_patterns
            )
            features['has_vague_message'] = 1.0 if is_vague else 0.0

            conventional_prefixes = ['feat:', 'fix:', 'docs:', 'style:', 'refactor:', 'test:', 'chore:']
            features['has_conventional_format'] = 1.0 if any(
                first_message.lower().startswith(prefix) for prefix in conventional_prefixes
            ) else 0.0

            features['has_description_body'] = 1.0 if '\n\n' in first_message else 0.0

        else:
            features['has_commit_message'] = 0.0
            features['commit_message_length'] = 0.0
            features['commit_message_word_count'] = 0.0
            features['has_vague_message'] = 0.0
            features['has_conventional_format'] = 0.0
            features['has_description_body'] = 0.0

        if pr_context:
            pr_title = pr_context.get('title', '')
            pr_body = pr_context.get('body', '')

            features['has_pr_title'] = 1.0 if pr_title.strip() else 0.0
            features['pr_title_length'] = float(len(pr_title))
            features['has_pr_description'] = 1.0 if pr_body.strip() else 0.0
            features['pr_description_length'] = float(len(pr_body))
            features['pr_description_word_count'] = float(len(pr_body.split()))
        else:
            features['has_pr_title'] = 0.0
            features['pr_title_length'] = 0.0
            features['has_pr_description'] = 0.0
            features['pr_description_length'] = 0.0
            features['pr_description_word_count'] = 0.0

        file_paths = []
        if pr_context and 'files' in pr_context:
            file_paths = [f.get('path', '') for f in pr_context['files']]

        if file_paths:
            test_files = [f for f in file_paths if 'test' in f.lower() or 'spec' in f.lower()]
            src_files = [f for f in file_paths if any(f.endswith(ext) for ext in ['.py', '.js', '.ts', '.java', '.go', '.rs'])]
            config_files = [f for f in file_paths if any(f.endswith(ext) for ext in ['.json', '.yaml', '.yml', '.toml', '.env'])]
            doc_files = [f for f in file_paths if any(f.endswith(ext) for ext in ['.md', '.txt', '.rst'])]

            features['num_test_files'] = float(len(test_files))
            features['num_src_files'] = float(len(src_files))
            features['num_config_files'] = float(len(config_files))
            features['num_doc_files'] = float(len(doc_files))

            features['modifies_license'] = 1.0 if any('LICENSE' in f.upper() for f in file_paths) else 0.0
            features['modifies_package_lock'] = 1.0 if any('package-lock.json' in f or 'yarn.lock' in f for f in file_paths) else 0.0

            unique_extensions = set(f.split('.')[-1] if '.' in f else '' for f in file_paths)
            features['file_type_diversity'] = float(len(unique_extensions)) / max(len(file_paths), 1)

            features['mixing_src_and_docs'] = 1.0 if (len(src_files) > 0 and len(doc_files) > 0) else 0.0
            features['mixing_code_and_deps'] = 1.0 if (len(src_files) > 0 and len(config_files) > 0) else 0.0

            if len(src_files) > 0:
                features['test_to_src_ratio'] = float(len(test_files)) / float(len(src_files))
                features['adds_code_without_tests'] = 1.0 if len(test_files) == 0 else 0.0
            else:
                features['test_to_src_ratio'] = 0.0
                features['adds_code_without_tests'] = 0.0
        else:
            features['num_test_files'] = 0.0
            features['num_src_files'] = 0.0
            features['num_config_files'] = 0.0
            features['num_doc_files'] = 0.0
            features['modifies_license'] = 0.0
            features['modifies_package_lock'] = 0.0
            features['file_type_diversity'] = 0.0
            features['mixing_src_and_docs'] = 0.0
            features['mixing_code_and_deps'] = 0.0
            features['test_to_src_ratio'] = 0.0
            features['adds_code_without_tests'] = 0.0

        if pr_context:
            features['pr_review_count'] = float(pr_context.get('reviews', {}).get('totalCount', 0))
            features['pr_comment_count'] = float(pr_context.get('comments', {}).get('totalCount', 0))
            features['pr_has_reviews'] = 1.0 if pr_context.get('reviews', {}).get('totalCount', 0) > 0 else 0.0

            if pr_context.get('createdAt') and pr_context.get('mergedAt'):
                from datetime import datetime
                created = datetime.fromisoformat(pr_context['createdAt'].replace('Z', '+00:00'))
                merged = datetime.fromisoformat(pr_context['mergedAt'].replace('Z', '+00:00'))
                merge_time_hours = (merged - created).total_seconds() / 3600
                features['pr_merged_quickly'] = 1.0 if merge_time_hours < 1 else 0.0
            else:
                features['pr_merged_quickly'] = 0.0
        else:
            features['pr_review_count'] = 0.0
            features['pr_comment_count'] = 0.0
            features['pr_has_reviews'] = 0.0
            features['pr_merged_quickly'] = 0.0

        return features

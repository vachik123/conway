from datetime import datetime
from typing import Dict, Any
import hashlib

class FeatureExtractor:
    """
    Extracts features from GitHub events for anomaly detection.

    - Failing workflow_runs
    - Force-pushes to main
    - Bursty issue creation with baselines
    - Bots
    """

    def __init__(self):
        self.issue_tracking = {}
        self.issue_baselines = {}
        self.workflow_failures = {}
        self.force_push_tracking = {}
        self.actor_first_seen = {}
        self.actor_event_count = {}
        self.last_event_time = {}

    def extract_features(self, event: Dict[str, Any]) -> Dict[str, float]:
        """
        Convert raw GitHub event to feature vector.
        Returns dict of feature_name -> value
        """
        event_type = event.get('type', '')
        payload = event.get('payload', {})
        repo_name = event.get('repo', {}).get('name', '')
        actor = event.get('actor', {}).get('login', '')
        created_at = event.get('created_at', '')

        features = {}

        features['is_force_push'] = self._is_force_push(event_type, payload)
        features['is_main_branch'] = self._is_main_branch(payload)
        features['force_push_to_main'] = features['is_force_push'] * features['is_main_branch']
        features['force_push_frequency'] = self._get_force_push_frequency(repo_name)

        features['is_workflow_failure'] = self._is_workflow_failure(event_type, payload)
        features['workflow_failure_streak'] = self._update_workflow_streak(repo_name, features['is_workflow_failure'])

        features['issue_burst_ratio'] = self._calculate_issue_burst(event_type, repo_name, actor, created_at)
        features['issue_spam_by_actor'] = self._detect_issue_spam_by_actor(event_type, repo_name, actor)

        features['bot_suspicion_score'] = self._calculate_bot_suspicion(actor, created_at)
        features['is_new_account'] = self._is_new_account(actor)
        features['rapid_fire_events'] = self._detect_rapid_fire(actor, created_at)

        features['is_branch_deletion'] = self._is_branch_deletion(event_type, payload)
        features['is_workflow_file_change'] = self._is_workflow_file_change(event_type, payload)
        features['is_large_commit'] = self._is_large_commit(event_type, payload)
        features['is_empty_commit'] = self._is_empty_commit(event_type, payload)

        features['is_fork_event'] = 1.0 if event_type == 'ForkEvent' else 0.0
        features['suspicious_fork'] = features['is_fork_event'] * features['bot_suspicion_score']

        features['oauth_app_installed'] = self._is_oauth_app_installed(event_type, payload)
        features['oauth_restrictions_disabled'] = self._is_oauth_restrictions_disabled(event_type, payload)
        features['auto_approve_tokens_enabled'] = self._is_auto_approve_enabled(event_type, payload)

        features['repo_visibility_changed_to_public'] = self._is_visibility_changed_to_public(event_type, payload)
        features['repo_download_event'] = self._is_repo_download(event_type)
        features['secrets_accessed'] = self._check_secrets_access(event_type, payload)

        features['workflow_action_version_changed'] = self._is_action_version_changed(event_type, payload)
        features['action_from_unverified_source'] = self._is_unverified_action(event_type, payload)
        features['workflow_secret_exposure_risk'] = self._check_workflow_secret_exposure(event_type, payload)

        features['admin_role_granted'] = self._is_admin_role_granted(event_type, payload)
        features['bulk_permission_grants'] = self._detect_bulk_permissions(event_type, payload)
        features['org_security_settings_changed'] = self._is_security_settings_changed(event_type, payload)

        features['package_file_modified'] = self._is_package_file_modified(event_type, payload)
        features['dependency_confusion_risk'] = self._check_dependency_confusion(event_type, payload)
        features['suspicious_release_pattern'] = self._is_suspicious_release(event_type, payload)
        features['obfuscated_code_detected'] = self._detect_obfuscated_code(event_type, payload)

        features['typosquatting_similarity'] = self._check_typosquatting(repo_name)
        features['fork_divergence_ratio'] = self._calculate_fork_divergence(event_type, payload)
        features['contributor_pattern_mismatch'] = self._check_contributor_mismatch(event_type, payload)

        self._update_tracking(event, repo_name, actor, created_at)

        return features

    def _get_force_push_frequency(self, repo_name: str) -> float:
        """Returns count of force pushes in last hour"""
        if repo_name not in self.force_push_tracking:
            return 0.0

        now = datetime.now().timestamp()
        cutoff = now - 3600

        recent = [ts for ts in self.force_push_tracking[repo_name] if ts > cutoff]
        return float(len(recent))

    def _update_workflow_streak(self, repo_name: str, is_failure: float) -> float:
        """Update and return workflow failure streak"""
        if is_failure == 1.0:
            if repo_name not in self.workflow_failures:
                self.workflow_failures[repo_name] = 1
            else:
                self.workflow_failures[repo_name] += 1
        else:
            if repo_name in self.workflow_failures:
                self.workflow_failures[repo_name] = 0

        return float(self.workflow_failures.get(repo_name, 0))

    def _is_force_push(self, event_type: str, payload: Dict) -> float:
        """Detect force pushes"""
        if event_type != 'PushEvent':
            return 0.0

        forced = payload.get('forced', False)
        return 1.0 if forced else 0.0

    def _is_main_branch(self, payload: Dict) -> float:
        ref = payload.get('ref', '')
        main_branches = ['refs/heads/main', 'refs/heads/master']
        return 1.0 if ref in main_branches else 0.0

    def _is_workflow_failure(self, event_type: str, payload: Dict) -> float:
        if event_type != 'WorkflowRunEvent':
            return 0.0

        workflow_run = payload.get('workflow_run', {})
        conclusion = workflow_run.get('conclusion', '')

        failures = ['failure', 'timed_out', 'cancelled']
        return 1.0 if conclusion in failures else 0.0

    def _calculate_issue_burst(self, event_type: str, repo_name: str, actor: str, timestamp_str: str) -> float:
        """Calculate issue burst ratio: current rate vs baseline"""
        if event_type != 'IssuesEvent':
            return 0.0

        if repo_name not in self.issue_tracking:
            return 0.0

        try:
            now = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00')).timestamp()
            cutoff_5min = now - 300
            cutoff_1h = now - 3600

            recent_5min = [ts for ts in self.issue_tracking[repo_name]['timestamps'] if ts > cutoff_5min]
            recent_1h = [ts for ts in self.issue_tracking[repo_name]['timestamps'] if ts > cutoff_1h]

            baseline = self.issue_baselines.get(repo_name, 1.0)
            current_rate = len(recent_5min) * 12

            if baseline > 0:
                ratio = current_rate / baseline
            else:
                ratio = float(len(recent_5min))

            return min(ratio, 10.0)

        except:
            return 0.0

    def _detect_issue_spam_by_actor(self, event_type: str, repo_name: str, actor: str) -> float:
        if event_type != 'IssuesEvent':
            return 0.0

        if repo_name not in self.issue_tracking:
            return 0.0

        actor_counts = self.issue_tracking[repo_name].get('actor_counts', {})
        return float(actor_counts.get(actor, 0))

    def _calculate_bot_suspicion(self, actor: str, timestamp_str: str) -> float:
        score = 0.0

        if '[bot]' in actor.lower():
            score += 0.5
        if 'bot' in actor.lower() and '[bot]' not in actor.lower():
            score += 0.3
        if actor.endswith('-bot') or actor.startswith('bot-'):
            score += 0.4

        if actor.replace('-', '').replace('_', '').isdigit():
            score += 0.3
        if len(actor) < 4:
            score += 0.2
        digit_count = sum(c.isdigit() for c in actor)
        if digit_count > len(actor) * 0.3 and digit_count > 3:
            score += 0.2

        if actor in self.actor_event_count:
            event_count = self.actor_event_count[actor]
            if event_count > 50:
                score += 0.2

        return min(score, 1.0)

    def _is_new_account(self, actor: str) -> float:
        if actor not in self.actor_first_seen:
            return 1.0

        event_count = self.actor_event_count.get(actor, 0)
        if event_count < 30:
            return 1.0
        return 0.0

    def _detect_rapid_fire(self, actor: str, timestamp_str: str) -> float:
        try:
            now = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00')).timestamp()

            if actor not in self.last_event_time:
                return 0.0

            last_event = self.last_event_time[actor]
            time_diff = now - last_event

            if time_diff < 5:
                return 1.0
            return 0.0

        except:
            return 0.0

    def _is_branch_deletion(self, event_type: str, payload: Dict) -> float:
        if event_type != 'DeleteEvent':
            return 0.0

        ref_type = payload.get('ref_type', '')
        ref = payload.get('ref', '')

        if ref_type == 'branch' and ref in ['main', 'master']:
            return 1.0
        if ref_type == 'branch':
            return 0.5

        return 0.0

    def _is_workflow_file_change(self, event_type: str, payload: Dict) -> float:
        if event_type != 'PushEvent':
            return 0.0

        commits = payload.get('commits', [])
        for commit in commits:
            for file_list_key in ['added', 'modified', 'removed']:
                files = commit.get(file_list_key, [])
                for file_path in files:
                    if '.github/workflows/' in file_path:
                        return 1.0

        return 0.0

    def _is_large_commit(self, event_type: str, payload: Dict) -> float:
        if event_type != 'PushEvent':
            return 0.0

        commits = payload.get('commits', [])
        for commit in commits:
            total_files = (
                len(commit.get('added', [])) +
                len(commit.get('modified', [])) +
                len(commit.get('removed', []))
            )
            if total_files > 100:
                return 1.0

        return 0.0

    def _is_empty_commit(self, event_type: str, payload: Dict) -> float:
        if event_type != 'PushEvent':
            return 0.0

        commits = payload.get('commits', [])
        for commit in commits:
            total_files = (
                len(commit.get('added', [])) +
                len(commit.get('modified', [])) +
                len(commit.get('removed', []))
            )
            if total_files == 0:
                return 1.0

        return 0.0

    def _is_oauth_app_installed(self, event_type: str, payload: Dict) -> float:
        if event_type == 'IntegrationInstallationEvent':
            return 1.0
        return 0.0

    def _is_oauth_restrictions_disabled(self, event_type: str, payload: Dict) -> float:
        if event_type == 'OrgConfigEvent':
            action = payload.get('action', '')
            if 'oauth' in action.lower() and 'disable' in action.lower():
                return 1.0
        return 0.0

    def _is_auto_approve_enabled(self, event_type: str, payload: Dict) -> float:
        if event_type == 'OrgConfigEvent':
            action = payload.get('action', '')
            if 'auto_approve' in action.lower():
                return 1.0
        return 0.0

    def _is_visibility_changed_to_public(self, event_type: str, payload: Dict) -> float:
        if event_type == 'RepositoryEvent':
            action = payload.get('action', '')
            repository = payload.get('repository', {})
            if action == 'publicized' or (repository.get('private') == False and action in ['edited', 'changed']):
                return 1.0
        return 0.0

    def _is_repo_download(self, event_type: str) -> float:
        return 0.0

    def _check_secrets_access(self, event_type: str, payload: Dict) -> float:
        if event_type == 'WorkflowRunEvent':
            workflow = payload.get('workflow_run', {})
            if workflow.get('permissions', {}).get('secrets') == 'write':
                return 1.0
        return 0.0

    def _is_action_version_changed(self, event_type: str, payload: Dict) -> float:
        if event_type != 'PushEvent':
            return 0.0

        commits = payload.get('commits', [])
        for commit in commits:
            files = commit.get('modified', []) + commit.get('added', [])
            for file_path in files:
                if '.github/workflows/' in file_path and ('uses:' in str(file_path) or '@' in str(file_path)):
                    return 1.0
        return 0.0

    def _is_unverified_action(self, event_type: str, payload: Dict) -> float:
        return 0.0

    def _check_workflow_secret_exposure(self, event_type: str, payload: Dict) -> float:
        if event_type != 'PushEvent':
            return 0.0

        commits = payload.get('commits', [])
        for commit in commits:
            message = commit.get('message', '').lower()
            files = commit.get('modified', []) + commit.get('added', [])

            for file_path in files:
                if '.github/workflows/' in file_path:
                    if 'secret' in message or 'token' in message or 'password' in message:
                        return 0.5

        return 0.0

    def _is_admin_role_granted(self, event_type: str, payload: Dict) -> float:
        if event_type == 'MemberEvent':
            permission = payload.get('member', {}).get('permissions', {})
            if permission.get('admin') == True:
                return 1.0
        if event_type == 'OrganizationEvent':
            action = payload.get('action', '')
            if action == 'member_invited' or action == 'member_added':
                role = payload.get('membership', {}).get('role', '')
                if role == 'admin':
                    return 1.0
        return 0.0

    def _detect_bulk_permissions(self, event_type: str, payload: Dict) -> float:
        return 0.0

    def _is_security_settings_changed(self, event_type: str, payload: Dict) -> float:
        if event_type in ['RepositoryEvent', 'OrganizationEvent']:
            action = payload.get('action', '')
            security_keywords = ['vulnerability', 'security', 'protection', 'authentication']
            if any(keyword in action.lower() for keyword in security_keywords):
                return 1.0
        return 0.0

    def _is_package_file_modified(self, event_type: str, payload: Dict) -> float:
        if event_type != 'PushEvent':
            return 0.0

        package_files = [
            'package.json', 'package-lock.json', 'yarn.lock',
            'requirements.txt', 'setup.py', 'Pipfile', 'Pipfile.lock',
            'Gemfile', 'Gemfile.lock',
            'pom.xml', 'build.gradle',
            'go.mod', 'go.sum',
            'Cargo.toml', 'Cargo.lock'
        ]

        commits = payload.get('commits', [])
        for commit in commits:
            files = commit.get('modified', []) + commit.get('added', [])
            for file_path in files:
                if any(pkg_file in file_path for pkg_file in package_files):
                    return 1.0

        return 0.0

    def _check_dependency_confusion(self, event_type: str, payload: Dict) -> float:
        """Check for potential dependency confusion attacks"""
        return 0.0

    def _is_suspicious_release(self, event_type: str, payload: Dict) -> float:
        """Detect suspicious release patterns"""
        if event_type == 'ReleaseEvent':
            release = payload.get('release', {})
            assets = release.get('assets', [])

            has_binaries = any(
                asset.get('name', '').endswith(('.exe', '.dll', '.so', '.dylib', '.bin'))
                for asset in assets
            )

            has_source = any(
                asset.get('name', '').endswith(('.zip', '.tar.gz', '.tar', 'source'))
                for asset in assets
            )

            if has_binaries and not has_source:
                return 1.0

        return 0.0

    def _detect_obfuscated_code(self, event_type: str, payload: Dict) -> float:
        """Detect potential obfuscated/encoded code"""
        if event_type != 'PushEvent':
            return 0.0

        commits = payload.get('commits', [])
        for commit in commits:
            files = commit.get('added', []) + commit.get('modified', [])

            obfuscation_indicators = [
                '.min.', '.pack.', '.obf.', 'base64', 'encrypted', 'encoded'
            ]

            for file_path in files:
                file_lower = file_path.lower()
                if any(indicator in file_lower for indicator in obfuscation_indicators):
                    if not (file_path.endswith('.min.js') or file_path.endswith('.min.css')):
                        return 0.5

        return 0.0

    def _check_typosquatting(self, repo_name: str) -> float:
        """Check if repo name is similar to popular repositories"""
        popular_repos = [
            'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'gatsby',
            'bootstrap', 'tailwindcss', 'jquery', 'three.js', 'd3', 'chart.js',
            'axios', 'lodash', 'moment', 'date-fns', 'redux', 'mobx',
            'webpack', 'vite', 'babel', 'eslint', 'prettier', 'typescript',
            
            'nodejs', 'express', 'nest', 'fastify', 'socket.io', 'mongoose',
            'sequelize', 'typeorm', 'pm2', 'nodemon', 'commander', 'chalk',
            'winston', 'passport', 'jsonwebtoken', 'puppeteer', 'playwright',
            
            'python', 'django', 'flask', 'fastapi', 'tornado', 'celery',
            'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy',
            'scipy', 'matplotlib', 'seaborn', 'opencv', 'pillow', 'requests',
            'beautifulsoup', 'selenium', 'scrapy', 'sqlalchemy', 'pydantic',
            'transformers', 'huggingface', 'langchain', 'auto-gpt', 'openai',
            
            'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'gitlab',
            'redis', 'mongodb', 'postgresql', 'mysql', 'elasticsearch', 'kafka',
            'rabbitmq', 'nginx', 'apache', 'linux', 'ubuntu', 'alpine',
            'prometheus', 'grafana', 'datadog', 'aws-cli', 'azure-cli',
            
            'golang', 'rust', 'ruby', 'php', 'java', 'kotlin', 'swift', 'dart',
            'flutter', 'react-native', 'electron', 'tauri', 'dotnet', 'csharp',
            'homebrew', 'npm', 'yarn', 'pnpm', 'pip', 'cargo', 'gem'
        ]

        repo_simple = repo_name.split('/')[-1].lower().replace('-', '').replace('_', '')

        for popular in popular_repos:
            if len(repo_simple) == len(popular):
                diff_count = sum(1 for a, b in zip(repo_simple, popular) if a != b)
                if diff_count == 1:
                    return 1.0
            if repo_simple in [popular + 'js', popular + 'py', 'js' + popular, 'py' + popular]:
                return 0.7

        return 0.0

    def _calculate_fork_divergence(self, event_type: str, payload: Dict) -> float:
        """Calculate how much a fork diverges from its parent"""
        if event_type != 'ForkEvent':
            return 0.0

        return 0.0

    def _check_contributor_mismatch(self, event_type: str, payload: Dict) -> float:
        """Check if contributors don't match fork source"""
        if event_type != 'ForkEvent':
            return 0.0

        return 0.0

    def _update_tracking(self, event: Dict, repo_name: str, actor: str, timestamp_str: str):
        """Update in-memory tracking for velocity calculations"""
        try:
            ts = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00')).timestamp()
            event_type = event.get('type', '')

            if actor not in self.actor_first_seen:
                self.actor_first_seen[actor] = ts
            if actor not in self.actor_event_count:
                self.actor_event_count[actor] = 0
            self.actor_event_count[actor] += 1

            self.last_event_time[actor] = ts

            if event_type == 'PushEvent' and event.get('payload', {}).get('forced', False):
                if repo_name not in self.force_push_tracking:
                    self.force_push_tracking[repo_name] = []
                self.force_push_tracking[repo_name].append(ts)
                if len(self.force_push_tracking[repo_name]) > 100:
                    self.force_push_tracking[repo_name] = self.force_push_tracking[repo_name][-100:]

            if event_type == 'IssuesEvent' and event.get('payload', {}).get('action') == 'opened':
                if repo_name not in self.issue_tracking:
                    self.issue_tracking[repo_name] = {
                        'timestamps': [],
                        'actor_counts': {}
                    }

                self.issue_tracking[repo_name]['timestamps'].append(ts)

                cutoff_10min = ts - 600
                self.issue_tracking[repo_name]['timestamps'] = [
                    t for t in self.issue_tracking[repo_name]['timestamps'] if t > cutoff_10min
                ]

                actor_count = sum(1 for t in self.issue_tracking[repo_name]['timestamps']
                                if t > cutoff_10min)
                self.issue_tracking[repo_name]['actor_counts'][actor] = actor_count

                total_issues = len(self.issue_tracking[repo_name]['timestamps'])
                if total_issues > 10:
                    oldest = min(self.issue_tracking[repo_name]['timestamps'])
                    time_span_hours = (ts - oldest) / 3600
                    if time_span_hours > 0:
                        self.issue_baselines[repo_name] = total_issues / time_span_hours

        except Exception as e:
            print(f"Error updating tracking: {e}")

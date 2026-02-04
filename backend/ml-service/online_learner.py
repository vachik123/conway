from river import linear_model, optim, preprocessing, metrics
import pickle
import os
from typing import Dict, Tuple
from datetime import datetime

class OnlineLearner:
    """
    Online learning model using River.
    Learns from streaming events and user feedback.
    """

    def __init__(self, model_path: str = 'model.pkl', metrics_path: str = 'metrics.pkl'):
        self.model_path = model_path
        self.metrics_path = metrics_path

        # Create a logistic regression model with online learning
        # StandardScaler normalizes features, SGD optimizes online
        self.model = (
            preprocessing.StandardScaler() |
            linear_model.LogisticRegression(
                optimizer=optim.SGD(lr=0.01)
            )
        )

        self.load_model()

        # Track predictions for feedback loop
        self.predictions = {}  # event_id -> (features, score, prediction)

        self.stats = {
            'total_predictions': 0,
            'total_trained': 0,
            'label_counts': {0: 0, 1: 0},
            'last_trained': None,
            'model_created': datetime.now().isoformat(),
        }

        # River metrics for online evaluation
        self.accuracy_metric = metrics.Accuracy()
        self.precision_metric = metrics.Precision()
        self.recall_metric = metrics.Recall()

        self.load_metrics()

    def predict(self, event_id: str, features: Dict[str, float]) -> Tuple[float, float]:
        """
        Predict anomaly score for an event.

        Returns:
            (probability, binary_prediction)
            - probability: 0.0-1.0 confidence that event is anomalous
            - binary_prediction: 0 or 1
        """
        try:
            # River expects dict features
            proba = self.model.predict_proba_one(features)

            # Get probability of class 1 (anomalous)
            score = proba.get(1, 0.0) if isinstance(proba, dict) else 0.5

            # Store for potential feedback
            self.predictions[event_id] = {
                'features': features,
                'score': score,
                'prediction': 1 if score > 0.5 else 0
            }

            self.stats['total_predictions'] += 1

            return score, 1 if score > 0.5 else 0
        except Exception as e:
            print(f"Prediction error: {e}")
            # Cold start: random score until we have training data
            return 0.5, 0

    def save_model(self):
        """Persist model to disk"""
        try:
            with open(self.model_path, 'wb') as f:
                pickle.dump(self.model, f)
            print(f"Model saved to {self.model_path}")
        except Exception as e:
            print(f"Error saving model: {e}")

    def load_model(self):
        """Load model from disk if exists"""
        if os.path.exists(self.model_path):
            try:
                with open(self.model_path, 'rb') as f:
                    self.model = pickle.load(f)
                print(f"Model loaded from {self.model_path}")
            except Exception as e:
                print(f"Error loading model: {e}")
        else:
            print("No existing model found, starting fresh")

    def save_metrics(self):
        """Persist metrics to disk"""
        try:
            with open(self.metrics_path, 'wb') as f:
                pickle.dump(self.stats, f)
        except Exception as e:
            print(f"Error saving metrics: {e}")

    def load_metrics(self):
        """Load metrics from disk if exists"""
        if os.path.exists(self.metrics_path):
            try:
                with open(self.metrics_path, 'rb') as f:
                    self.stats = pickle.load(f)
                print(f"Metrics loaded from {self.metrics_path}")
            except Exception as e:
                print(f"Error loading metrics: {e}")
        else:
            print("No existing metrics found, starting fresh")

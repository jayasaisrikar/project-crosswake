"""Feature store: registry of causal feature definitions + cached long-format values."""

from engine.features.registry import REGISTRY, FeatureDef, feature, get_feature, list_features, register
from engine.features.store import FeatureStore, compute_wide, input_hash, to_records, to_wide

__all__ = [
    "REGISTRY", "FeatureDef", "FeatureStore", "compute_wide", "feature", "get_feature", "input_hash",
    "list_features", "register", "to_records", "to_wide",
]

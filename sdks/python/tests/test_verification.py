from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "python" / "src"))

from almira import verify_verification_receipt  # noqa: E402


class VerificationReceiptTest(unittest.TestCase):
    def test_common_vector_and_resource_substitution(self) -> None:
        common = json.loads((ROOT / "conformance" / "application-sdk.v1.json").read_text())
        vector = common["behavior_receipt"]
        self.assertTrue(
            verify_verification_receipt(vector["signed"], vector["key_set"], vector["expected"])
        )
        substituted = {**vector["expected"], **vector["substitution"]}
        self.assertFalse(
            verify_verification_receipt(vector["signed"], vector["key_set"], substituted)
        )
        tampered = copy.deepcopy(vector["signed"])
        tampered["receipt"]["generation_id"] = substituted["generation_id"]
        self.assertFalse(verify_verification_receipt(tampered, vector["key_set"]))


if __name__ == "__main__":
    unittest.main()

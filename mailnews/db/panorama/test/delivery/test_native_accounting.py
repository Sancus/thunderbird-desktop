# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Synthetic native-log contract checks; no native binary is executed."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

import native_accounting as native


class NativeAccountingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.log = Path(temp.name) / "raw.jsonl"
        self.selected = "DISABLED_DeliveryCoreReferences.ExactTokensSurviveReopen"
        self.events = [
            {"action": "suite_start", "source": "gtest", "name": "gtest", "tests": {}},
            {"action": "group_start", "name": "DISABLED_DeliveryCoreReferences"},
            {"action": "test_start", "test": self.selected},
            {"action": "test_end", "test": self.selected, "status": "PASS"},
            {"action": "group_end", "name": "DISABLED_DeliveryCoreReferences"},
            {"action": "suite_end", "source": "gtest"},
        ]

    def check(self, events, **kwargs):
        self.log.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
        return native.check_log(self.log, self.selected, kwargs.pop("returncode", 0), **kwargs)

    def reject(self, events, **kwargs):
        result = self.check(events, **kwargs)
        self.assertFalse(result["log_complete"])
        self.assertEqual(result["coverage"], "none")
        self.assertTrue(result["execution_hold"])
        return result

    def test_complete_log_is_structural_only_and_never_product_acceptance(self):
        result = self.check(self.events)
        self.assertTrue(result["log_complete"])
        self.assertEqual(result["counts"]["test_start"], 1)
        self.assertEqual(result["counts"]["test_end"], 1)
        self.assertIsNone(result["first_failure"])
        self.assertTrue(result["execution_hold"])
        self.assertEqual(result["coverage"], "none")

    def test_empty_disabled_only_and_missing_events_are_rejected(self):
        self.reject([])
        self.reject([self.events[0], self.events[-1]])
        for index in range(len(self.events)):
            with self.subTest(missing=index):
                self.reject(self.events[:index] + self.events[index + 1:])
        for index in range(len(self.events)):
            with self.subTest(duplicate=index):
                self.reject(self.events[:index] + [self.events[index]] + self.events[index:])
        self.reject(self.events[1:] + self.events[:1])

    def test_wrong_or_extra_case_and_wildcard_selection_are_rejected(self):
        wrong = copy.deepcopy(self.events)
        wrong[2]["test"] = "DISABLED_DeliveryCoreReferences.WrongCase"
        self.reject(wrong)
        extra = [{"action": "test_start", "test": "OtherSuite.Extra"},
                 {"action": "test_end", "test": "OtherSuite.Extra", "status": "PASS"}]
        self.reject(self.events[:4] + extra + self.events[4:])
        wrong = copy.deepcopy(self.events)
        wrong[1]["name"] = "OtherSuite"
        self.reject(wrong)
        self.check(self.events)
        for selection in ("*", "DISABLED_DeliveryCoreReferences.*", self.selected + ":Other.Extra"):
            result = native.check_log(self.log, selection, 0)
            self.assertFalse(result["log_complete"])
            self.assertIn("require one exact catalog filter", result["errors"])
        for index, field, value in ((0, "source", "xpcshell"), (0, "tests", []),
                                    (5, "source", "other")):
            wrong = copy.deepcopy(self.events)
            wrong[index][field] = value
            self.reject(wrong)

    def test_fail_skip_crash_timeout_and_nonzero_exit_cannot_be_success(self):
        for status in ("FAIL", "SKIP", "CRASH", "TIMEOUT", "NOTRUN"):
            events = copy.deepcopy(self.events)
            events[3].update(status=status, expected=status)
            with self.subTest(status=status):
                self.reject(events)
        for event in ({"action": "crash"},
                      {"action": "log", "level": "ERROR", "message": "shutdown failed"},
                      {"action": "test_status", "test": self.selected, "status": "FAIL", "expected": "PASS"}):
            result = self.reject(self.events[:3] + [event] + self.events[3:])
            self.assertEqual(result["first_failure"], event)
        for code in (1, -11, None):
            self.reject(self.events, returncode=code)
        self.reject(self.events, timed_out=True)
        self.reject(self.events[:2] + [{"action": "test_status", "test": self.selected,
                                       "status": "PASS"}] + self.events[2:])

    def test_malformed_truncated_missing_and_unexpected_logs_are_rejected(self):
        for raw in ("", "[]\n", "{}\n", "text\n", '{"action":',
                    json.dumps(self.events[0])):
            self.log.write_text(raw, encoding="utf-8")
            self.assertFalse(native.check_log(self.log, self.selected, 0)["log_complete"])
        self.log.unlink()
        self.assertFalse(native.check_log(self.log, self.selected, 0)["log_complete"])
        self.reject(self.events + [{"action": "unexpected"}])


if __name__ == "__main__":
    unittest.main()

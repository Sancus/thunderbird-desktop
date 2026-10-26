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

    def test_folder_info_selection_is_independent_and_teardown_failure_is_fatal(self):
        self.selected = "DISABLED_DeliveryFolderInfoProperties.BooleanWideIsTrue"
        for index in (1, 4):
            self.events[index]["name"] = "DISABLED_DeliveryFolderInfoProperties"
        for index in (2, 3):
            self.events[index]["test"] = self.selected
        self.assertTrue(self.check(self.events)["log_complete"])
        wrong = copy.deepcopy(self.events)
        wrong[4]["name"] = "DISABLED_DeliveryCoreReferences"
        self.reject(wrong)
        failure = {"action": "test_status", "test": self.selected,
                   "status": "FAIL", "message": "suite close barrier failed"}
        result = self.reject(self.events[:4] + [failure] + self.events[4:])
        self.assertEqual(result["first_failure"], failure)
        for status in ("SKIP", "FAIL"):
            wrong = copy.deepcopy(self.events)
            wrong[3]["status"] = status
            self.reject(wrong)

    def test_catalog_suites_match_integrated_disabled_sources_and_receipt_dependencies(self):
        import re
        import run_native
        comm = native.HERE.parents[4]
        catalog = native.CATALOG
        self.assertEqual(catalog["schema"], 2)
        self.assertEqual(len(catalog["cases"]), 137)
        for suite, declaration in catalog["suites"].items():
            self.assertTrue(suite.startswith("DISABLED_"))
            source = comm / declaration["source"]
            names = re.findall(r"TEST_F\(\s*" + suite + r",\s*(\w+)\s*\)", source.read_text())
            filters = {suite + "." + name for name in names}
            selected = [c["filter"] for c in catalog["cases"] if c["filter"].startswith(suite + ".")]
            self.assertEqual(set(selected), filters)
            self.assertEqual(len(selected), len(filters))
            self.assertEqual(len(names), len(filters))
            for path in [declaration["source"], *declaration["source_dependencies"]]:
                self.assertTrue((comm / path).is_file(), path)
                self.assertIn(path, run_native.COMM_INPUTS)

    def test_message_references_has_only_the_reviewed_filters_and_dependencies(self):
        suite = "DISABLED_DeliveryMessageReferences"
        expected = {
            "CountSuccessAssignsOnlyUint16", "CountKnownEmptyAssignsZero",
            "CountUnavailableLeavesZero", "CountMissingLeavesZero",
            "CountReadStepErrorLeavesZero", "CountOverflowLeavesZero",
            "IndexedUnavailablePreservesSentinel", "IndexedMissingPreservesSentinel",
            "IndexedReadStepErrorPreservesSentinel", "IndexedNegativePreservesSentinel",
            "IndexedPastEndPreservesSentinel", "NullCountKnownOversizedSucceeds",
            "NullCountUnavailablePropagates", "NullCountMissingPropagates",
            "NullCountReadStepErrorPropagates", "EmbeddedNulStopsDelimitedReferences",
            "EmbeddedNulStopsBareReference", "SetReferencesInsertAbortPreservesCommittedTokens",
            "SetReferencesDeferredCommitFailurePreservesCommittedTokens",
        }
        declaration = native.CATALOG["suites"].get(suite)
        self.assertIsNotNone(declaration, "The accepted suite must be registered")
        self.assertEqual(declaration["source"],
                         "mailnews/db/panorama/test/gtest/TestDeliveryMessageReferences.cpp")
        dependencies = set(declaration["source_dependencies"])
        self.assertTrue({"mailnews/db/panorama/src/Message.cpp",
                         "mailnews/db/panorama/src/Message.h",
                         "mailnews/base/public/nsIMsgHdr.idl"} <= dependencies)
        rows = [c for c in native.CATALOG["cases"] if c["filter"].startswith(suite + ".")]
        self.assertEqual({c["filter"] for c in rows}, {suite + "." + name for name in expected})
        self.assertEqual(len(rows), 19)
        self.assertEqual(len({c["id"] for c in native.CATALOG["cases"]}), 137)
        for row in rows:
            large = row["filter"].rsplit(".", 1)[-1] in {
                "CountOverflowLeavesZero", "NullCountKnownOversizedSucceeds"}
            self.assertEqual(row.get("timeout_seconds"), 1800 if large else None)
            self.selected = row["filter"]
            for index in (1, 4):
                self.events[index]["name"] = suite
            for index in (2, 3):
                self.events[index]["test"] = self.selected
            self.assertTrue(self.check(self.events)["log_complete"])
        wrong = copy.deepcopy(self.events)
        wrong[1]["name"] = "DISABLED_DeliveryCoreReferences"
        self.reject(wrong)
        self.reject(self.events, timed_out=True)
        self.reject(self.events, returncode=1)
        wrong = copy.deepcopy(self.events)
        wrong[3]["status"] = "SKIP"
        self.reject(wrong)
        comm = native.HERE.parents[4]
        build = (comm / "mailnews/db/panorama/test/gtest/moz.build").read_text()
        self.assertIn('"TestDeliveryMessageReferences.cpp"', build)

    def test_core_existence_exact_disabled_filters(self):
        suite = "DISABLED_DeliveryCoreMessageExistence"
        expected = {"WarmHeaderDeletionUsesStoredMembership", "ColdRowDeletionUsesStoredMembership",
                    "RemovalCallbackSeesAbsentRowAndReadableHeader", "WarmHeaderPrepareFailurePropagates",
                    "ColdRowPrepareFailurePropagates", "WarmHeaderStepFailurePropagates",
                    "ColdRowStepFailurePropagates", "SingleFolderFilterUsesStoredIdentity",
                    "MultiFolderFilterUsesStoredIdentity", "VirtualFolderFilterUsesStoredIdentity",
                    "ColdRemovalCallbackSeesCommittedRowAndReadableHeader",
                    "WarmRemovalUsesReturnedStoredFields",
                    "RemovalStepFailureRollsBackWithoutNotification",
                    "RemovalCommitFailureRollsBackWithoutNotification",
                    "RemovalRejectsForeignTransaction",
                    "ThreadKeysPreserveMembershipAndDepthFirstOrder", "EmptyThreadKeysReplaceOutput",
                    "ThreadKeysFolderBindError", "ThreadKeysParentBindError", "ThreadKeysThreadBindError",
                    "ThreadKeysPrepareError", "ThreadKeysFirstStepError", "ThreadKeysErrorAfterSeedRow",
                    "ConversationFilterRejectsThreadReadFailure"}
        rows = [c for c in native.CATALOG["cases"] if c["filter"].startswith(suite + ".")]
        self.assertEqual({c["filter"] for c in rows}, {suite + "." + n for n in expected})
        self.assertEqual(len(rows), 24)
        self.assertEqual(native.CATALOG["suites"][suite]["source"],
                         "mailnews/db/panorama/test/gtest/TestDeliveryCoreMessageExistence.cpp")
        for row in rows:
            name = row["filter"].partition(".")[2]
            self.assertEqual(row["id"], "core-native:MessageExistence:" + name)
            self.selected = row["filter"]
            for index in (1, 4):
                self.events[index]["name"] = suite
            for index in (2, 3):
                self.events[index]["test"] = self.selected
            self.assertTrue(self.check(self.events)["log_complete"])
        self.reject(self.events, returncode=1)
        self.reject(self.events, timed_out=True)
        wrong = copy.deepcopy(self.events)
        wrong[3]["status"] = "SKIP"
        self.reject(wrong)
        for selected in (suite + ".*", self.selected + ":" + rows[0]["filter"]):
            self.assertFalse(native.check_log(self.log, selected, 0)["log_complete"])
        dependencies = set(native.CATALOG["suites"][suite]["source_dependencies"])
        required = {"mailnews/db/panorama/src/" + name for name in (
            "MessageDatabase.cpp", "MessageDatabase.h", "Message.cpp", "Message.h",
            "DatabaseCore.cpp", "DatabaseCore.h", "FolderDatabase.cpp", "FolderDatabase.h")}
        required.update({"mailnews/db/panorama/src/LiveViewFilters.h",
                         "mailnews/db/panorama/src/DetachedMsgHdr.cpp",
                         "mailnews/db/panorama/src/DetachedMsgHdr.h",
                         "mailnews/base/public/nsIMsgHdr.idl"})
        self.assertTrue(required <= dependencies, required - dependencies)
        self.assertEqual(native.CATALOG["backend"], "panorama")
        self.assertEqual(native.CATALOG["store"], "none")
        self.assertEqual(native.CATALOG["readiness"], "pending-product")
        self.assertTrue(native.CATALOG["execution_hold"])



    def test_property_and_detached_suites_select_only_reviewed_disabled_filters(self):
        expected = {
            "CoreProperties": [
                "MessageNamesAndTextAreExact", "FolderNamesAndTextAreExact",
                "NativeIntegersAndStructuralValuesRemainTyped", "CoreReopenKeepsExactTextAndPresence",
                "FailedMessageOverwritePreservesRows", "FailedFolderOverwritePreservesRows",
                "ReadErrorsAreNotAbsentProperties", "StepErrorsPreserveOutputSentinels",
                "UpgradePreservesExistingValues", "UpgradeDoesNotDropUnknownIndex",
                "FailedUpgradeRollsBackAndRetries",
            ],
            "HeaderProperties": [
                "Uint32SuccessAssignsOnlyUint32", "Uint32MaximumAssignsOnlyUint32",
                "Uint32MissingReplacesSentinelWithZero", "Uint32EmptyReplacesSentinelWithZero",
                "Uint32InvalidPrefixReplacesSentinelWithZero", "Uint32NineDigitsUseFirstEight",
                "Uint32NullKnownOutputIsRejected", "Uint32NullOutputDoesNotEvaluateSQL",
                "Uint32PrepareErrorPreservesSentinel", "Uint32ReadStepErrorPreservesSentinel",
            ],
            "DetachedThreadIdentity": [
                "DefaultIsUnknown", "PositiveIdRoundTrips",
                "FullWidthRepeatedReads", "ZeroAndSentinelRoundTrip",
                "NullOutputIsRejected", "IdentityIsIndependentOfMetadata",
            ],
        }
        for name, names in expected.items():
            suite = "DISABLED_Delivery" + name
            rows = [c for c in native.CATALOG["cases"] if c["filter"].startswith(suite + ".")]
            self.assertEqual([c["filter"] for c in rows], [suite + "." + n for n in names])
            source = "TestDeliveryCoreProperties.cpp" if name == "CoreProperties" else "TestDeliveryMessageReferences.cpp"
            self.assertEqual(native.CATALOG["suites"][suite]["source"],
                             "mailnews/db/panorama/test/gtest/" + source)
            for row in rows:
                self.selected = row["filter"]
                for index in (1, 4):
                    self.events[index]["name"] = suite
                for index in (2, 3):
                    self.events[index]["test"] = self.selected
                self.assertTrue(self.check(self.events)["log_complete"])
                self.reject(self.events[:3] + self.events[4:])
                self.reject(self.events, returncode=1)
                self.reject(self.events, timed_out=True)
                wrong = copy.deepcopy(self.events)
                wrong[3]["status"] = "SKIP"
                self.reject(wrong)
                wrong = copy.deepcopy(self.events)
                wrong[3]["test"] = "DISABLED_DeliveryCoreReferences.ExactTokensSurviveReopen"
                self.reject(wrong)
                self.assertFalse(native.check_log(self.log, suite + ".*", 0)["log_complete"])


    def test_thread_query_controls_are_individually_selectable_without_runtime_credit(self):
        suite = "DISABLED_DeliveryCoreMessageExistence"
        names = {
            "ThreadKeysPreserveMembershipAndDepthFirstOrder", "EmptyThreadKeysReplaceOutput",
            "ThreadKeysFolderBindError", "ThreadKeysParentBindError", "ThreadKeysThreadBindError",
            "ThreadKeysPrepareError", "ThreadKeysFirstStepError", "ThreadKeysErrorAfterSeedRow"}
        rows = [c for c in native.CATALOG["cases"] if c["filter"] in {suite + "." + n for n in names}]
        self.assertEqual({c["filter"] for c in rows}, {suite + "." + n for n in names})
        self.assertEqual(len(rows), 8)
        for row in rows:
            self.assertEqual(row["id"], "core-native:MessageExistence:" + row["filter"].split(".")[1])
            self.selected = row["filter"]
            for index in (1, 4):
                self.events[index]["name"] = suite
            for index in (2, 3):
                self.events[index]["test"] = self.selected
            result = self.check(self.events)
            self.assertTrue(result["log_complete"])
            self.assertEqual(result["coverage"], "none")
            self.assertTrue(result["execution_hold"])
            for index in (2, 3):
                self.reject(self.events[:index] + self.events[index + 1:])
                self.reject(self.events[:index] + [self.events[index]] + self.events[index:])
            self.reject(self.events, timed_out=True)
            self.reject(self.events, returncode=1)
            wrong = copy.deepcopy(self.events)
            wrong[3]["status"] = "SKIP"
            self.reject(wrong)


    def test_complete_publication_filters_are_isolated_manual_cases(self):
        expected = {
            "DISABLED_DeliveryCoreReferences": [
                "NativePublicationIsCompleteAtFirstCallback",
                "NativeQuietPublicationStillReachesInternalObservers",
                "NativeExtrasKeepExactNamesTextAndOrder",
                "NativeEmptyKeywordsOverrideNamedDefault",
                "NativeAbsentStorageRetainsExactExtras",
                "NativePresentStorageOverridesExactExtras",
                "NativeReceivedDateUsesLegacySecondsText",
                "NativePropertyFailureLeavesOutputsAndControlIntact",
                "NativePublicationRejectsForeignTransactionAndNullKey",
                "NativeBorrowedInputSupportsReentrantReuse",
            ],
            "DISABLED_DeliveryCompleteHeader": [
                "DetachedAliasesPreserveExplicitEmpty",
                "RawExtrasKeepOrderCaseAndUtf8",
                "UnspecifiedStorageRemainsAbsent",
                "AbsentStorageOptionalsPreserveExtras",
                "ExplicitStorageZeroAndEmptyOverrideExtras",
                "DetachedUint32RetainsTypedStorage",
                "FailedAttachmentDoesNotReplay",
            ],
        }
        for suite, names in expected.items():
            rows = [c for c in native.CATALOG["cases"]
                    if c["filter"].startswith(suite + ".") and c["filter"].split(".")[1] in names]
            self.assertEqual([c["filter"] for c in rows], [suite + "." + name for name in names])
            source = ("TestDeliveryCoreReferences.cpp" if suite.endswith("CoreReferences")
                      else "TestDeliveryMessageReferences.cpp")
            self.assertEqual(native.CATALOG["suites"][suite]["source"],
                             "mailnews/db/panorama/test/gtest/" + source)
            for row in rows:
                self.selected = row["filter"]
                for index in (1, 4):
                    self.events[index]["name"] = suite
                for index in (2, 3):
                    self.events[index]["test"] = self.selected
                checked = self.check(self.events)
                self.assertTrue(checked["log_complete"])
                self.assertEqual(checked["coverage"], "none")
                self.assertTrue(checked["execution_hold"])
                self.reject(self.events[:3] + self.events[4:])
                self.reject(self.events[:3] + [self.events[2]] + self.events[3:])
                self.reject(self.events, returncode=1)
                self.reject(self.events, timed_out=True)
                wrong = copy.deepcopy(self.events)
                wrong[3]["status"] = "SKIP"
                self.reject(wrong)
                wrong[3].update(status="PASS", test="OtherSuite.WrongCase")
                self.reject(wrong)
                self.assertFalse(native.check_log(self.log, suite + ".*", 0)["log_complete"])

    def test_captured_thread_filters_are_exact_manual_isolated_cases(self):
        suite = "DISABLED_DeliveryCoreReferences"
        names = {"CaptureOwnsHistoricalRowFacts", "CaptureMissingRowPreservesOutput",
                 "CaptureReadErrorPreservesOutput", "PreparedBatchOwnsPendingPublication",
                 "BatchPreparationFailurePreservesOutput", "CaptureReadsStagedSqlWithoutCacheMutation"}
        rows = [c for c in native.CATALOG["cases"] if c["id"].startswith("core-native:CapturedThread:")]
        self.assertEqual({c["filter"] for c in rows}, {suite + "." + n for n in names})
        self.assertEqual(len(rows), 6)
        for row in rows:
            self.assertEqual(row["id"], "core-native:CapturedThread:" + row["filter"].partition(".")[2])
            self.selected = row["filter"]
            for index in (1, 4):
                self.events[index]["name"] = suite
            for index in (2, 3):
                self.events[index]["test"] = self.selected
            self.assertTrue(self.check(self.events)["log_complete"])
            self.reject(self.events, returncode=1)
            self.reject(self.events, timed_out=True)
            wrong = copy.deepcopy(self.events)
            wrong[3]["status"] = "SKIP"
            self.reject(wrong)
            wrong = copy.deepcopy(self.events)
            wrong[3]["test"] = suite + ".differentCase"
            self.reject(wrong)
        for selected in (suite + ".*", self.selected + ":" + rows[0]["filter"]):
            self.assertFalse(native.check_log(self.log, selected, 0)["log_complete"])


    def test_component_discovery_filters_require_exact_single_case_evidence(self):
        suite = "DISABLED_DeliveryCoreReferences"
        names = {"DiscoverOrderedCrossFolder", "DiscoverReplyBeforeParent",
                 "DiscoverSiblingsWithoutParent", "DiscoverSiblingsThenParent",
                 "DiscoverDuplicatePhysicalCopies", "DiscoverWholeStoredComponent",
                 "DiscoverExactReferenceTokens", "DiscoverMissingRowPreservesOutput",
                 "DiscoverUnavailableHistoryPreservesOutput", "DiscoverReadErrorPreservesOutput",
                 "DiscoverReadsStagedReferences"}
        rows = [c for c in native.CATALOG["cases"] if c["id"].startswith("core-native:ComponentDiscovery:")]
        self.assertEqual({c["filter"] for c in rows}, {suite + "." + n for n in names})
        self.assertEqual(len(rows), 11)
        self.assertEqual(native.CATALOG["readiness"], "pending-product")
        for row in rows:
            self.assertEqual(row["id"], "core-native:ComponentDiscovery:" + row["filter"].partition(".")[2])
            self.selected = row["filter"]
            for index in (1, 4):
                self.events[index]["name"] = suite
            for index in (2, 3):
                self.events[index]["test"] = self.selected
            self.assertTrue(self.check(self.events)["log_complete"])
            for missing in (2, 3):
                self.reject(self.events[:missing] + self.events[missing + 1:])
            wrong = copy.deepcopy(self.events)
            wrong[3]["test"] = suite + ".DiscoverDifferentCase"
            self.reject(wrong)
            for status in ("SKIP", "FAIL"):
                wrong = copy.deepcopy(self.events)
                wrong[3]["status"] = status
                self.reject(wrong)
            self.reject(self.events, returncode=1)
            self.reject(self.events, timed_out=True)
        self.check(self.events)
        for selected in (suite + ".*", self.selected + ":" + rows[0]["filter"]):
            self.assertFalse(native.check_log(self.log, selected, 0)["log_complete"])
        declaration = native.CATALOG["suites"][suite]
        required = {"mailnews/db/panorama/" + p for p in (
            "src/MessageDatabase.cpp", "src/MessageDatabase.h", "src/DatabaseCore.cpp",
            "src/DatabaseCore.h", "src/DatabaseUtils.cpp", "src/DatabaseUtils.h",
            "src/Message.cpp", "src/Message.h", "src/FolderDatabase.cpp", "src/FolderDatabase.h",
            "test/gtest/moz.build", "src/moz.build", "public/moz.build")}
        self.assertTrue(required <= set(declaration["source_dependencies"]))
        self.assertEqual(declaration["source"],
                         "mailnews/db/panorama/test/gtest/TestDeliveryCoreReferences.cpp")


if __name__ == "__main__":
    unittest.main()

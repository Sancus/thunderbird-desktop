/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "nsImapUtils.h"
#include "nsImapFlagAndUidState.h"
#include "nsImapMailFolder.h"

// Invocation:
// $ ./mach gtest "TestMsgImapUtils.*"

// Test AllocateImapUidString() and ParseUidString.
TEST(TestMsgImapUtils, ImapUidSets)
{
  static const struct {
    nsTArray<ImapUid> uids;   // Individual IMAP UIDs.
    nsLiteralCString uidSet;  // Uids as an IMAP UID set string.
    uint32_t count;           // Number of UIDs.
  } uidTests[] = {
      {{42}, "42"_ns, 1},
      {{1, 2, 3, 4, 5}, "1:5"_ns, 5},
      {{10, 20, 30}, "10,20,30"_ns, 3},
      {{1, 2, 3, 4, 5, 10, 11, 12}, "1:5,10:12"_ns, 8},
      // Preserve ordering (not sure how important this is).
      {{5, 4, 3, 2, 1}, "5,4,3,2,1"_ns, 5},
  };

  // Test AllocateImapUidString().
  for (auto const& t : uidTests) {
    nsCString got;
    uint32_t count = t.count;
    AllocateImapUidString(t.uids.Elements(), count, nullptr, got);
    ASSERT_EQ(t.uidSet, got);
    ASSERT_EQ(t.count, count);  // Shouldn't be clipped.
  }

  // Test ParseUidString().
  for (auto const& t : uidTests) {
    nsTArray<ImapUid> gotUids;
    ParseUidString(t.uidSet.get(), gotUids);
    ASSERT_EQ(t.uids, gotUids);
  }
}

// Test UidSetFromUids().
TEST(TestMsgImapUtils, UidSetFromUids)
{
  static const struct {
    nsTArray<ImapUid> uids;   // Individual IMAP UIDs.
    nsLiteralCString uidSet;  // Uids as an IMAP UID-set string.
  } uidTests[] = {
      // NOTE: These test cases reflect style choices in the implementation
      // which are mostly obvious and sensible (sorted, de-duped)...
      // But the spec doesn't mandate this. A conformant implementation could
      // return different results.
      {{}, ""_ns},
      {{42}, "42"_ns},
      {{1, 2, 3, 4, 5}, "1:5"_ns},
      {{4, 5, 1, 3, 2}, "1:5"_ns},  // Input doesn't need to be sorted.
      {{10, 20, 30}, "10,20,30"_ns},
      {{1, 2, 3, 4, 5, 10, 11, 12}, "1:5,10:12"_ns},
      {{4, 12, 3, 11, 5, 10, 1, 2}, "1:5,10:12"_ns},
      {{1, 1, 1, 1, 1, 4, 5, 5, 5, 6, 7, 10}, "1,4:7,10"_ns},
      // Don't use range syntax for pairs (style choice).
      {{1, 2, 6, 7}, "1,2,6,7"_ns},
      // Make sure nothing falls over with max 32 bit unsigned value.
      {{4294967293, 4294967294, 4294967295}, "4294967293:4294967295"_ns},
  };

  for (auto const& t : uidTests) {
    nsCString got = UidSetFromUids(t.uids);
    ASSERT_EQ(t.uidSet, got);
  }
}

TEST(TestMsgImapUtils, MessageUriQuery)
{
  static const struct {
    nsLiteralCString uri;
    nsLiteralCString folder;
    nsLiteralCString part;
  } tests[] = {
      {"imap-message://user@host/INBOX#42"_ns, "imap://user@host/INBOX"_ns,
       ""_ns},
      {"imap-message://user@host/INBOX#42?editasnew=true"_ns,
       "imap://user@host/INBOX"_ns, ""_ns},
      {"imap-message://user@host/INBOX?editasnew=true#42"_ns,
       "imap://user@host/INBOX"_ns, ""_ns},
      {"imap-message://user@host/INBOX?editasnew=true&x=1#42"_ns,
       "imap://user@host/INBOX"_ns, ""_ns},
      {"imap-message://user%40example@host/Caf%C3%A9%3F%23%25#42?editasnew=true"_ns,
       "imap://user%40example@host/Caf%C3%A9%3F%23%25"_ns, ""_ns},
      {"imap-message://user%40example@host/Caf%C3%A9%3F%23%25?editasnew=true#42"_ns,
       "imap://user%40example@host/Caf%C3%A9%3F%23%25"_ns, ""_ns},
      {"imap-message://user@host/INBOX#42?part=1.2&filename=imap://host/a#name"_ns,
       "imap://user@host/INBOX"_ns, "?part=1.2&filename=imap://host/a#name"_ns},
  };
  for (const auto& test : tests) {
    SCOPED_TRACE(test.uri.get());
    nsCString folder;
    nsCString part;
    nsMsgKey key = nsMsgKey_None;
    ASSERT_EQ(NS_OK, nsParseImapMessageURI(test.uri, folder, &key, part));
    EXPECT_EQ(test.folder, folder);
    EXPECT_EQ(42u, key);
    EXPECT_EQ(test.part, part);
  }
}

TEST(TestMsgImapUtils, ImapUidSetsDoNotInferCachedMembers)
{
  RefPtr<nsImapFlagAndUidState> state = new nsImapFlagAndUidState(0);
  ASSERT_EQ(NS_OK, state->AddUidFlagPair(5, 0, 0));
  ASSERT_EQ(NS_OK, state->AddUidFlagPair(7, 0, 1));
  state->SetPartialUIDFetch(false);
  const ImapUid uids[] = {5, 7};
  uint32_t count = 2;
  nsCString got;
  AllocateImapUidString(uids, count, state, got);
  EXPECT_EQ("5,7"_ns, got);
  EXPECT_EQ(2u, count);
}

TEST(TestMsgImapUtils, ImapUidSetsKeepUncachedInputs)
{
  RefPtr<nsImapFlagAndUidState> state = new nsImapFlagAndUidState(0);
  ASSERT_EQ(NS_OK, state->AddUidFlagPair(1001, 0, 0));
  state->SetPartialUIDFetch(false);
  const ImapUid uids[] = {1003, 1005};
  uint32_t count = 2;
  nsCString got;
  AllocateImapUidString(uids, count, state, got);
  EXPECT_EQ("1003,1005"_ns, got);
  EXPECT_EQ(2u, count);
}

TEST(TestMsgImapUtils, ImapUidSetsKeepLargestUid)
{
  const ImapUid uids[] = {4294967293, 4294967294, 4294967295};
  uint32_t count = 3;
  nsCString got;
  AllocateImapUidString(uids, count, nullptr, got);
  EXPECT_EQ("4294967293:4294967295"_ns, got);
  EXPECT_EQ(3u, count);
}

TEST(TestMsgImapUtils, ImapUidChunksPreserveEveryInput)
{
  nsTArray<ImapUid> uids;
  for (ImapUid uid = 10001; uid < 10801; uid += 2) uids.AppendElement(uid);
  for (bool partial : {false, true}) {
    RefPtr<nsImapFlagAndUidState> state = new nsImapFlagAndUidState(0);
    state->SetPartialUIDFetch(partial);
    nsTArray<ImapUid> actual;
    uint32_t chunks = 0;
    while (actual.Length() < uids.Length()) {
      uint32_t start = actual.Length();
      uint32_t count = uids.Length() - start;
      nsCString chunk;
      AllocateImapUidString(uids.Elements() + start, count, state, chunk);
      ASSERT_GT(count, 0u);
      ASSERT_LE(count, uids.Length() - start);
      // The 950-byte threshold can be crossed by the last UID and punctuation.
      EXPECT_LE(chunk.Length(), 962u);
      nsTArray<ImapUid> expanded;
      ParseUidString(chunk.get(), expanded);
      ASSERT_EQ(count, expanded.Length());
      for (uint32_t i = 0; i < count; ++i)
        EXPECT_EQ(uids[start + i], expanded[i]);
      actual.AppendElements(expanded);
      ++chunks;
    }
    EXPECT_GT(chunks, 1u);
    EXPECT_EQ(uids, actual);
  }
}

TEST(TestMsgImapUtils, ImapUidRangesKeepLargestEndpoint)
{
  nsTArray<ImapUid> parsed;
  ParseUidString("4294967293:4294967295", parsed);
  EXPECT_EQ((nsTArray<ImapUid>{4294967293, 4294967294, 4294967295}), parsed);
  parsed.Clear();
  // Keep the existing repeated-endpoint behavior without uint32 overflow.
  ParseUidString("4294967295:4294967295", parsed);
  EXPECT_EQ((nsTArray<ImapUid>{4294967295, 4294967295}), parsed);
  parsed.Clear();
  ParseUidString("42:42", parsed);
  EXPECT_EQ((nsTArray<ImapUid>{42, 42}), parsed);
  parsed.Clear();
  ParseUidString("4294967295:4294967293", parsed);
  EXPECT_EQ((nsTArray<ImapUid>{4294967295, 4294967294, 4294967293}), parsed);
  parsed.Clear();
  ParseUidString("1005:1003", parsed);
  EXPECT_EQ((nsTArray<ImapUid>{1005, 1004, 1003}), parsed);
}

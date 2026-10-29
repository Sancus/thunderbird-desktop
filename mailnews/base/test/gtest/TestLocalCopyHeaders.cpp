/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "OfflineStorage.h"
#include "nsMsgMessageFlags.h"
#include "gtest/gtest.h"
#ifdef MOZ_PANORAMA
#  include "DetachedMsgHdr.h"

namespace {

// Exercise the helper's public header contract, including logical tags which
// are not enumerated as arbitrary properties and injected setter failures.
class CopyHeader final : public mozilla::mailnews::DetachedMsgHdr {
 public:
  CopyHeader() : DetachedMsgHdr(1) {}

  NS_IMETHOD GetProperties(nsTArray<nsCString>& names) override {
    nsresult rv = DetachedMsgHdr::GetProperties(names);
    if (mHideKeywords) names.RemoveElement("keywords"_ns);
    return rv;
  }
  NS_IMETHOD GetStringProperty(const char* name, nsACString& value) override {
    if (nsDependentCString(name).EqualsLiteral("keywords") &&
        NS_FAILED(mKeywordRead)) {
      return mKeywordRead;
    }
    return DetachedMsgHdr::GetStringProperty(name, value);
  }
  NS_IMETHOD SetStringProperty(const char* name,
                               const nsACString& value) override {
    if (nsDependentCString(name).EqualsLiteral("keywords") &&
        NS_FAILED(mKeywordWrite)) {
      return mKeywordWrite;
    }
    return DetachedMsgHdr::SetStringProperty(name, value);
  }
  NS_IMETHOD SetFlags(uint32_t flags) override {
    if (NS_FAILED(mFlagsWrite)) return mFlagsWrite;
    return DetachedMsgHdr::SetFlags(flags);
  }

  bool mHideKeywords = false;
  nsresult mKeywordRead = NS_OK;
  nsresult mKeywordWrite = NS_OK;
  nsresult mFlagsWrite = NS_OK;
};

}  // namespace

TEST(LocalCopyHeaders, LogicalKeywordsAndStorageExclusions)
{
  RefPtr<CopyHeader> source = new CopyHeader;
  RefPtr<CopyHeader> destination = new CopyHeader;
  ASSERT_EQ(NS_OK,
            source->SetStringProperty("keywords", "Source source  Source"_ns));
  source->mHideKeywords = true;
  ASSERT_EQ(NS_OK, source->SetStringProperty("opaque", "000A"_ns));
  ASSERT_EQ(NS_OK, source->SetStoreToken("source-token"_ns));
  ASSERT_EQ(NS_OK, destination->SetStoreToken("destination-token"_ns));
  ASSERT_EQ(NS_OK, source->SetFlags(nsMsgMessageFlags::Read |
                                    nsMsgMessageFlags::HasRe));
  ASSERT_EQ(NS_OK, destination->SetFlags(nsMsgMessageFlags::Marked |
                                         nsMsgMessageFlags::New));
  ASSERT_EQ(NS_OK, LocalCopyHeaders(source, destination, {}));
  nsCString value;
  ASSERT_EQ(NS_OK, destination->GetStringProperty("keywords", value));
  EXPECT_EQ("Source source  Source"_ns, value);
  ASSERT_EQ(NS_OK, destination->GetStringProperty("opaque", value));
  EXPECT_EQ("000A"_ns, value);
  ASSERT_EQ(NS_OK, destination->GetStoreToken(value));
  EXPECT_EQ("destination-token"_ns, value);
  uint32_t flags;
  ASSERT_EQ(NS_OK, destination->GetFlags(&flags));
  EXPECT_EQ(uint32_t(nsMsgMessageFlags::Marked | nsMsgMessageFlags::Read |
                     nsMsgMessageFlags::HasRe),
            flags);
}

TEST(LocalCopyHeaders, KeywordsRespectExactExclusion)
{
  RefPtr<CopyHeader> source = new CopyHeader;
  RefPtr<CopyHeader> destination = new CopyHeader;
  ASSERT_EQ(NS_OK, source->SetStringProperty("keywords", "source-key"_ns));
  ASSERT_EQ(NS_OK,
            destination->SetStringProperty("keywords", "destination-key"_ns));
  source->mHideKeywords = true;
  source->mKeywordRead = NS_ERROR_FILE_ACCESS_DENIED;
  ASSERT_EQ(NS_OK, LocalCopyHeaders(source, destination, {"keywords"_ns}));
  nsCString value;
  ASSERT_EQ(NS_OK, destination->GetStringProperty("keywords", value));
  EXPECT_EQ("destination-key"_ns, value);
}

TEST(LocalCopyHeaders, EmptyKeywordsPreserveStoredPresence)
{
  RefPtr<CopyHeader> source = new CopyHeader;
  RefPtr<CopyHeader> destination = new CopyHeader;
  ASSERT_EQ(NS_OK, LocalCopyHeaders(source, destination, {}));
  nsTArray<nsCString> names;
  ASSERT_EQ(NS_OK, destination->GetProperties(names));
  EXPECT_FALSE(names.Contains("keywords"_ns));
  ASSERT_EQ(NS_OK, source->SetStringProperty("keywords", ""_ns));
  ASSERT_EQ(NS_OK, LocalCopyHeaders(source, destination, {}));
  ASSERT_EQ(NS_OK, destination->GetProperties(names));
  EXPECT_TRUE(names.Contains("keywords"_ns));
  nsCString value;
  ASSERT_EQ(NS_OK, destination->GetStringProperty("keywords", value));
  EXPECT_TRUE(value.IsEmpty());
}

TEST(LocalCopyHeaders, OriginalKeywordAndFlagsErrors)
{
  RefPtr<CopyHeader> source = new CopyHeader;
  RefPtr<CopyHeader> destination = new CopyHeader;
  source->mKeywordRead = NS_ERROR_FILE_ACCESS_DENIED;
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED,
            LocalCopyHeaders(source, destination, {}));
  source->mKeywordRead = NS_OK;
  ASSERT_EQ(NS_OK, source->SetStringProperty("keywords", "source-key"_ns));
  source->mHideKeywords = true;
  destination->mKeywordWrite = NS_ERROR_FILE_NO_DEVICE_SPACE;
  destination->mFlagsWrite = NS_ERROR_STORAGE_CONSTRAINT;
  EXPECT_EQ(NS_ERROR_FILE_NO_DEVICE_SPACE,
            LocalCopyHeaders(source, destination, {}));
  destination->mKeywordWrite = NS_OK;
  EXPECT_EQ(NS_ERROR_STORAGE_CONSTRAINT,
            LocalCopyHeaders(source, destination, {}));
}
#endif  // MOZ_PANORAMA

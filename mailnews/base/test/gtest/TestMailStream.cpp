#include <utility>

#include "gtest/gtest.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "mozilla/Preferences.h"
#include "OfflineStorage.h"
#include "nsMsgDBFolder.h"
#include "CopyMessageStreamListener.h"
#include "nsIInputStreamPump.h"
#include "nsString.h"
#include "nsNetUtil.h"
#include "nsStringStream.h"
#include "MailStream.h"

// Invocation:
// $ ./mach gtest "TestMailStream.*"

typedef nsCString (*genFn)();

// Some (well-formed) test messages.
static const struct {
  genFn Header;
  genFn Body;
  nsCString All() const { return Header() + Body(); }
} wellFormedMsgs[] = {
    // Simple case works?
    {
        // Header + separatorline.
        []() -> nsCString {
          return "Message-ID: one\r\nTo: alice@example.com\r\n\r\n"_ns;
        },
        // Body.
        []() -> nsCString {
          return "Body here.\r\nNote: this line looks like a header, but it isn't!\r\n"_ns;
        },
    },
    // Works with bare LF line endings (rather than CRLF)?
    {
        // Header + separatorline.
        []() -> nsCString {
          return "Message-ID: one\nTo: alice@example.com\n\n"_ns;
        },
        // Body.
        []() -> nsCString {
          return "Body here.\nNote: this line looks like a header, but it isn't!\n"_ns;
        },
    },
    // Folded header values don't screw things up?
    {
        // Header.
        []() -> nsCString {
          return "To: bob@example.com\r\n"
                 "Subject: Do\r\n"
                 " we\r\n"
                 " handle\r\n"
                 "\tfolded\r\n"  // Can fold with tabs too.
                 " fields OK?\r\n"
                 "Message-ID: two\r\n"
                 "\r\n"_ns;
        },
        // Body.
        []() -> nsCString { return "...message body here...\r\n"_ns; },
    },
    // Huge header block works? (to test that buffer resizing works).
    {
        // Header - aiming for ~250KB.
        []() -> nsCString {
          nsCString out;
          for (int i = 0; i < 10000; ++i) {
            out.AppendFmt("Name{:#06d}: value{:#06d}\r\n", i, i);  // 25 bytes
          }
          // Need the separator line.
          out.Append("\r\n");
          return out;
        },
        // Body.
        []() -> nsCString { return "...message body here...\r\n"_ns; },
    },
    // Huge body works? (to make sure reads will hit the underlying stream
    // once we read past the buffer).
    {
        // Minimal Header.
        []() -> nsCString { return "Foo: bar\r\n\r\n"_ns; },
        // Huge Body - aiming for about 250KB.
        []() -> nsCString {
          nsCString out;
          for (int i = 0; i < 10000; ++i) {
            out.AppendFmt("this is line {:#06d}....\r\n", i);  // 25 bytes
          }
          return out;
        },
    },
};

// We should be able to access the header block _before_ we
// read anything from the stream.
TEST(TestMailStream, HeaderBeforeReading)
{
  for (auto const& t : wellFormedMsgs) {
    nsCOMPtr<nsIInputStream> raw;
    ASSERT_EQ(NS_OK, NS_NewCStringInputStream(getter_AddRefs(raw), t.All()));

    RefPtr<MailStream> wrapped = new MailStream(raw);

    // HeaderBlock() should return the header block exactly.
    nsCString gotHeader(wrapped->HeaderBlock().unwrap());
    ASSERT_EQ(gotHeader, t.Header());

    // Read() should return the entire message (including header block).
    nsCString gotWhole;
    ASSERT_EQ(NS_OK,
              NS_ReadInputStreamToString(wrapped, gotWhole, -1, nullptr));
    ASSERT_EQ(gotWhole, t.All());
  }
}

// The header block should be available even _after_ the stream
// has been drained.
TEST(TestMailStream, HeaderAfterReading)
{
  //  for (size_t i = 0; i < std::size(wellFormedMsgs); ++i) {
  for (auto const& t : wellFormedMsgs) {
    //   auto const& t = wellFormedMsgs[i];
    nsCOMPtr<nsIInputStream> raw;
    ASSERT_EQ(NS_OK, NS_NewCStringInputStream(getter_AddRefs(raw), t.All()));

    RefPtr<MailStream> wrapped = new MailStream(raw);

    // Read() should return the entire message (including header block).
    nsCString gotWhole;
    ASSERT_EQ(NS_OK,
              NS_ReadInputStreamToString(wrapped, gotWhole, -1, nullptr));
    ASSERT_EQ(gotWhole, t.All());

    // HeaderBlock() should return the header block exactly.
    nsCString gotHeader(wrapped->HeaderBlock().unwrap());
    ASSERT_EQ(gotHeader, t.Header());
  }
}

// Make sure messages without an obvious header block are rejected.
TEST(TestMailStream, RejectBadlyFormedMsg)
{
  nsCString badMsgs[] = {"This has no header block"_ns};

  for (auto& bad : badMsgs) {
    nsCOMPtr<nsIInputStream> raw;
    ASSERT_EQ(NS_OK, NS_NewCStringInputStream(getter_AddRefs(raw), bad));

    RefPtr<MailStream> wrapped = new MailStream(raw);
    ASSERT_TRUE(wrapped->HeaderBlock().isErr());
  }
}

// Ensure oversized header blocks are rejected.
TEST(TestMailStream, RejectLudicrouslyLargeHeader)
{
  nsCString badMsg("Blah: BLAHBLAHBLAHBLAHBLAHBLAHBLAHBLAHBLAHBLAHBLAH\r\n");
  while (badMsg.Length() <= MailStream::kMaxHeaderSize) {
    badMsg.Append(badMsg);  // Double the size.
  }
  badMsg.Append("\r\nTeeny tiny message body.\r\n");

  nsCOMPtr<nsIInputStream> raw;
  ASSERT_EQ(NS_OK, NS_NewCStringInputStream(getter_AddRefs(raw), badMsg));
  RefPtr<MailStream> wrapped = new MailStream(raw);

  ASSERT_TRUE(wrapped->HeaderBlock().isErr());
}

namespace {

class CopyStreamDestination final : public nsICopyMessageListener {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  NS_IMETHOD BeginCopy() override {
    ++mBegins;
    return mBeginResult;
  }
  NS_IMETHOD StartMessage() override { return NS_OK; }
  NS_IMETHOD CopyData(nsIInputStream* stream, int32_t length) override {
    ++mDataCalls;
    nsCString data;
    nsresult rv = NS_ReadInputStreamToString(stream, data, length, nullptr);
    if (NS_FAILED(rv)) {
      return rv;
    }
    mData.Append(data);
    if (mCancelOnData) {
      mCancelResult = mCancelOnData->Cancel(NS_BINDING_ABORTED);
    }
    return mDataResult;
  }
  NS_IMETHOD EndMessage(nsMsgKey key) override { return NS_OK; }
  NS_IMETHOD EndCopy(bool succeeded) override {
    ++mCopies;
    mCopySucceeded = succeeded;
    return NS_OK;
  }
  NS_IMETHOD EndMove(bool succeeded) override {
    ++mMoves;
    mMoveSucceeded = succeeded;
    return NS_OK;
  }

  nsCString mData;
  nsCOMPtr<nsIRequest> mCancelOnData;
  nsresult mBeginResult = NS_OK;
  nsresult mDataResult = NS_OK;
  nsresult mCancelResult = NS_ERROR_NOT_INITIALIZED;
  uint32_t mBegins = 0;
  uint32_t mDataCalls = 0;
  uint32_t mCopies = 0;
  uint32_t mMoves = 0;
  bool mCopySucceeded = false;
  bool mMoveSucceeded = false;

 private:
  ~CopyStreamDestination() = default;
};

NS_IMPL_ISUPPORTS(CopyStreamDestination, nsICopyMessageListener)

class CopyMessageStreamListenerTest : public ::testing::Test {
 protected:
  nsresult Start(bool statusCallback, bool isMove,
                 nsIMsgFolder* sourceFolder = nullptr) {
    nsCOMPtr<nsIInputStream> stream;
    nsresult rv = NS_NewCStringInputStream(getter_AddRefs(stream),
                                           "Subject: copy\r\n\r\nbody\r\n"_ns);
    if (NS_FAILED(rv)) {
      return rv;
    }
    rv = NS_NewInputStreamPump(getter_AddRefs(mPump), stream.forget());
    if (NS_FAILED(rv)) {
      return rv;
    }
    std::function<nsresult(nsresult)> endCopy;
    if (statusCallback) {
      endCopy = [this](nsresult status) {
        ++mCompletions;
        mStatus = status;
        return NS_OK;
      };
    }
    RefPtr<CopyMessageStreamListener> listener =
        new CopyMessageStreamListener(mDestination, isMove, std::move(endCopy));
    nsCOMPtr<nsIStreamListener> streamListener = listener;
    if (sourceFolder) {
      nsCOMPtr<nsIChannel> channel =
          do_CreateInstance("@mozilla.org/network/input-stream-channel;1", &rv);
      if (NS_FAILED(rv)) {
        return rv;
      }
      streamListener =
          new OfflineMessageReadListener(listener, channel, 42, sourceFolder);
    }
    return mPump->AsyncRead(streamListener);
  }

  bool Wait() {
    return mozilla::SpinEventLoopUntil(
        "CopyMessageStreamListenerTest"_ns,
        [this] { return mCompletions || mDestination->mCopies; });
  }

  RefPtr<CopyStreamDestination> mDestination = new CopyStreamDestination();
  nsCOMPtr<nsIInputStreamPump> mPump;
  uint32_t mCompletions = 0;
  nsresult mStatus = NS_ERROR_NOT_INITIALIZED;
};

}  // namespace

TEST_F(CopyMessageStreamListenerTest, LegacyMove) {
  ASSERT_EQ(NS_OK, Start(false, true));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(1u, mDestination->mBegins);
  EXPECT_EQ("Subject: copy\r\n\r\nbody\r\n"_ns, mDestination->mData);
  EXPECT_EQ(1u, mDestination->mCopies);
  EXPECT_TRUE(mDestination->mCopySucceeded);
  EXPECT_EQ(1u, mDestination->mMoves);
  EXPECT_TRUE(mDestination->mMoveSucceeded);
  EXPECT_EQ(0u, mCompletions);
}

TEST_F(CopyMessageStreamListenerTest, LegacyFailedMove) {
  mDestination->mDataResult = NS_ERROR_FILE_NO_DEVICE_SPACE;
  ASSERT_EQ(NS_OK, Start(false, true));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(1u, mDestination->mDataCalls);
  EXPECT_EQ(1u, mDestination->mCopies);
  EXPECT_FALSE(mDestination->mCopySucceeded);
  EXPECT_EQ(1u, mDestination->mMoves);
  EXPECT_FALSE(mDestination->mMoveSucceeded);
}

TEST_F(CopyMessageStreamListenerTest, StatusCallbackSuccess) {
  ASSERT_EQ(NS_OK, Start(true, false));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(NS_OK, mStatus);
  EXPECT_EQ(1u, mCompletions);
  EXPECT_EQ("Subject: copy\r\n\r\nbody\r\n"_ns, mDestination->mData);
  EXPECT_EQ(0u, mDestination->mCopies);
  EXPECT_EQ(0u, mDestination->mMoves);
}

TEST_F(CopyMessageStreamListenerTest, ExactRequestFailure) {
  ASSERT_EQ(NS_OK, Start(true, true));
  ASSERT_EQ(NS_OK, mPump->Cancel(NS_ERROR_UNEXPECTED));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mStatus);
  EXPECT_EQ(1u, mCompletions);
  EXPECT_EQ(1u, mDestination->mBegins);
  EXPECT_TRUE(mDestination->mData.IsEmpty());
  EXPECT_EQ(0u, mDestination->mCopies);
  EXPECT_EQ(1u, mDestination->mMoves);
  EXPECT_FALSE(mDestination->mMoveSucceeded);
}

TEST_F(CopyMessageStreamListenerTest, BeginFailure) {
  mDestination->mBeginResult = NS_ERROR_FILE_ACCESS_DENIED;
  ASSERT_EQ(NS_OK, Start(true, false));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, mStatus);
  EXPECT_EQ(1u, mCompletions);
  EXPECT_EQ(1u, mDestination->mBegins);
  EXPECT_EQ(0u, mDestination->mDataCalls);
  EXPECT_EQ(0u, mDestination->mCopies);
  EXPECT_EQ(0u, mDestination->mMoves);
}

TEST_F(CopyMessageStreamListenerTest, CopyFailurePrecedesCancellation) {
  mDestination->mDataResult = NS_ERROR_FILE_NO_DEVICE_SPACE;
  ASSERT_EQ(NS_OK, Start(true, true));
  mDestination->mCancelOnData = mPump;
  ASSERT_TRUE(Wait());
  nsresult requestStatus;
  ASSERT_EQ(NS_OK, mPump->GetStatus(&requestStatus));
  EXPECT_EQ(NS_BINDING_ABORTED, requestStatus);
  EXPECT_EQ(NS_OK, mDestination->mCancelResult);
  EXPECT_EQ(NS_ERROR_FILE_NO_DEVICE_SPACE, mStatus);
  EXPECT_EQ("Subject: copy\r\n\r\nbody\r\n"_ns, mDestination->mData);
  EXPECT_EQ(1u, mDestination->mDataCalls);
  EXPECT_EQ(1u, mCompletions);
  EXPECT_EQ(0u, mDestination->mCopies);
  EXPECT_EQ(1u, mDestination->mMoves);
  EXPECT_FALSE(mDestination->mMoveSucceeded);
}

namespace {

// Only records the cache eviction requested by the real read listener.
class OfflineReadFolder final : public nsMsgDBFolder {
 public:
  NS_IMETHOD DiscardOfflineMsg(nsMsgKey key) override {
    ++mDiscards;
    mDiscardedKey = key;
    return NS_OK;
  }

  uint32_t mDiscards = 0;
  nsMsgKey mDiscardedKey = nsMsgKey_None;

 private:
  ~OfflineReadFolder() = default;
  nsresult GetDatabase() override { return NS_ERROR_NOT_IMPLEMENTED; }
};

class OfflineMessageReadListenerTest : public CopyMessageStreamListenerTest {
 protected:
  void SetUp() override {
    mHadPref = mozilla::Preferences::HasUserValue(kPref);
    mOldPref = mozilla::Preferences::GetBool(kPref, true);
    ASSERT_EQ(NS_OK, mozilla::Preferences::SetBool(kPref, true));
  }

  void TearDown() override {
    if (mHadPref) {
      EXPECT_EQ(NS_OK, mozilla::Preferences::SetBool(kPref, mOldPref));
    } else {
      EXPECT_EQ(NS_OK, mozilla::Preferences::ClearUser(kPref));
    }
  }

  static constexpr char kPref[] = "mail.discard_offline_msg_on_failure";
  RefPtr<OfflineReadFolder> mFolder = new OfflineReadFolder();
  bool mHadPref = false;
  bool mOldPref = true;
};

}  // namespace

TEST_F(OfflineMessageReadListenerTest, ConsumerStartFailureKeepsSource) {
  mDestination->mBeginResult = NS_ERROR_FILE_ACCESS_DENIED;
  ASSERT_EQ(NS_OK, Start(true, false, mFolder));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, mStatus);
  EXPECT_EQ(1u, mCompletions);
  EXPECT_EQ(0u, mFolder->mDiscards);
}

TEST_F(OfflineMessageReadListenerTest, ConsumerWriteFailureKeepsSource) {
  mDestination->mDataResult = NS_ERROR_FILE_NO_DEVICE_SPACE;
  ASSERT_EQ(NS_OK, Start(true, false, mFolder));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(NS_ERROR_FILE_NO_DEVICE_SPACE, mStatus);
  EXPECT_EQ(1u, mCompletions);
  EXPECT_EQ("Subject: copy\r\n\r\nbody\r\n"_ns, mDestination->mData);
  EXPECT_EQ(0u, mFolder->mDiscards);
}

TEST_F(OfflineMessageReadListenerTest, NonConsumerFailureStillDiscardsSource) {
  ASSERT_EQ(NS_OK, Start(true, false, mFolder));
  ASSERT_EQ(NS_OK, mPump->Cancel(NS_ERROR_UNEXPECTED));
  ASSERT_TRUE(Wait());
  EXPECT_EQ(NS_ERROR_UNEXPECTED, mStatus);
  EXPECT_EQ(1u, mCompletions);
  EXPECT_EQ(1u, mFolder->mDiscards);
  EXPECT_EQ(42u, mFolder->mDiscardedKey);
}

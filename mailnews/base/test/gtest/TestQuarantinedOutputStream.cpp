/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "mozilla/RefPtr.h"
#include "nsQuarantinedOutputStream.h"
#include "nsISeekableStream.h"
#include "nsString.h"

namespace {

// Injects only the inner result; the wrapper and temporary-file I/O are real.
class FinishFailureTarget final : public nsIOutputStream,
                                  public nsISafeOutputStream {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  NS_IMETHOD Close() override {
    ++closeCalls;
    return closeResult;
  }
  NS_IMETHOD Flush() override { return NS_OK; }
  NS_IMETHOD Write(const char* data, uint32_t count,
                   uint32_t* written) override {
    bytes.Append(data, count);
    *written = count;
    return NS_OK;
  }
  NS_IMETHOD WriteFrom(nsIInputStream*, uint32_t, uint32_t*) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  NS_IMETHOD WriteSegments(nsReadSegmentFun, void*, uint32_t,
                           uint32_t*) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  NS_IMETHOD IsNonBlocking(bool* value) override {
    *value = false;
    return NS_OK;
  }
  NS_IMETHOD StreamStatus() override { return NS_OK; }
  NS_IMETHOD Finish() override {
    ++finishCalls;
    return finishCalls == 1 ? NS_ERROR_FILE_ACCESS_DENIED : NS_OK;
  }

  nsCString bytes;
  uint32_t finishCalls{0};
  uint32_t closeCalls{0};
  nsresult closeResult{NS_OK};

 private:
  ~FinishFailureTarget() = default;
};

NS_IMPL_ISUPPORTS(FinishFailureTarget, nsIOutputStream, nsISafeOutputStream)

TEST(QuarantinedOutputStream, RetainsInnerFinishFailure)
{
  RefPtr<FinishFailureTarget> target = new FinishFailureTarget();
  RefPtr<nsQuarantinedOutputStream> stream =
      new nsQuarantinedOutputStream(target);
  nsCString data(
      "Subject: native finish failure\r\n\r\nReal wrapper body.\r\n"_ns);
  uint32_t written = 0;
  ASSERT_EQ(NS_OK, stream->Write(data.get(), data.Length(), &written));
  ASSERT_EQ(data.Length(), written);
  ASSERT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->Finish());
  ASSERT_EQ(data, target->bytes);
  ASSERT_EQ(1u, target->finishCalls);
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->Close());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->Finish());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->StreamStatus());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->Close());
  EXPECT_EQ(1u, target->finishCalls);
}

// The wrapper and its temporary file are real. Only the destination stream's
// write and rollback results are controlled at their actual XPCOM boundary.
class AppendFailureTarget final : public nsIOutputStream,
                                  public nsISafeOutputStream,
                                  public nsISeekableStream {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_IMETHOD Close() override { return NS_OK; }
  NS_IMETHOD Flush() override { return NS_OK; }
  NS_IMETHOD Write(const char* data, uint32_t count,
                   uint32_t* written) override {
    ++writeCalls;
    *written = 0;
    if (zeroProgress && writeCalls == 1) {
      return NS_OK;
    }
    uint32_t prefix = count < 2 ? count : 2;
    bytes.Append(data, prefix);
    position = bytes.Length();
    *written = prefix;
    return NS_ERROR_FILE_NO_DEVICE_SPACE;
  }
  NS_IMETHOD WriteFrom(nsIInputStream*, uint32_t, uint32_t*) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  NS_IMETHOD WriteSegments(nsReadSegmentFun, void*, uint32_t,
                           uint32_t*) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  NS_IMETHOD IsNonBlocking(bool* value) override {
    *value = false;
    return NS_OK;
  }
  NS_IMETHOD StreamStatus() override { return NS_OK; }
  NS_IMETHOD Finish() override {
    ++finishCalls;
    return NS_OK;
  }
  NS_IMETHOD Seek(int32_t whence, int64_t offset) override {
    ++seekCalls;
    if (NS_FAILED(seekResult)) return seekResult;
    if (whence != NS_SEEK_SET || offset < 0 ||
        offset > static_cast<int64_t>(bytes.Length())) {
      return NS_ERROR_INVALID_ARG;
    }
    position = offset;
    return NS_OK;
  }
  NS_IMETHOD Tell(int64_t* offset) override {
    *offset = position;
    return NS_OK;
  }
  NS_IMETHOD SetEOF() override {
    ++truncateCalls;
    if (NS_FAILED(truncateResult)) return truncateResult;
    bytes.Truncate(static_cast<uint32_t>(position));
    return NS_OK;
  }

  nsCString bytes{"Original destination bytes"_ns};
  int64_t position{static_cast<int64_t>(bytes.Length())};
  nsresult seekResult{NS_OK};
  nsresult truncateResult{NS_OK};
  bool zeroProgress{false};
  uint32_t writeCalls{0};
  uint32_t finishCalls{0};
  uint32_t seekCalls{0};
  uint32_t truncateCalls{0};

 private:
  ~AppendFailureTarget() = default;
};

NS_IMPL_ISUPPORTS(AppendFailureTarget, nsIOutputStream, nsISafeOutputStream,
                  nsISeekableStream)

static void CheckAppendFailure(nsresult seekResult, nsresult truncateResult,
                               bool zeroProgress = false) {
  RefPtr<AppendFailureTarget> target = new AppendFailureTarget();
  target->seekResult = seekResult;
  target->truncateResult = truncateResult;
  target->zeroProgress = zeroProgress;
  const nsCString original = target->bytes;
  const nsCString data(
      "Subject: failed append\r\n\r\nNew message bytes.\r\n"_ns);
  RefPtr<nsQuarantinedOutputStream> stream =
      new nsQuarantinedOutputStream(target);
  uint32_t written = 0;
  ASSERT_EQ(NS_OK, stream->Write(data.get(), data.Length(), &written));
  ASSERT_EQ(data.Length(), written);
  const nsresult expected =
      zeroProgress ? NS_ERROR_UNEXPECTED : NS_ERROR_FILE_NO_DEVICE_SPACE;
  ASSERT_EQ(expected, stream->Finish());
  EXPECT_EQ(1u, target->writeCalls);
  EXPECT_EQ(0u, target->finishCalls);
  EXPECT_EQ(1u, target->seekCalls);
  EXPECT_EQ(NS_SUCCEEDED(seekResult) ? 1u : 0u, target->truncateCalls);
  nsCString retained(original);
  if (NS_FAILED(seekResult) || NS_FAILED(truncateResult)) {
    retained.Append(data.get(), 2);
  }
  EXPECT_EQ(retained, target->bytes);
  EXPECT_EQ(expected, stream->StreamStatus());
  EXPECT_EQ(expected, stream->Close());
  EXPECT_EQ(expected, stream->Finish());
  EXPECT_EQ(expected, stream->Close());
  EXPECT_EQ(1u, target->writeCalls);
  EXPECT_EQ(0u, target->finishCalls);
  EXPECT_EQ(retained, target->bytes);
}

TEST(QuarantinedOutputStream, RetainsAppendFailureAfterRollback)
{
  CheckAppendFailure(NS_OK, NS_OK);
}

TEST(QuarantinedOutputStream, RetainsAppendFailureWhenSeekFails)
{
  CheckAppendFailure(NS_ERROR_FILE_ACCESS_DENIED, NS_OK);
}

TEST(QuarantinedOutputStream, RetainsAppendFailureWhenTruncateFails)
{
  CheckAppendFailure(NS_OK, NS_ERROR_FILE_ACCESS_DENIED);
}

TEST(QuarantinedOutputStream, RejectsZeroProgressAppend)
{
  CheckAppendFailure(NS_OK, NS_OK, true);
}

// Close the wrapper's real temporary stream at the actual pre-copy boundary.
class ClosedTemporaryStream final : public nsQuarantinedOutputStream {
 public:
  explicit ClosedTemporaryStream(nsIOutputStream* target)
      : nsQuarantinedOutputStream(target) {}
  nsresult CloseTemporaryStream() { return mTempStream->Close(); }
  nsresult TemporaryFlushStatus() { return mTempStream->Flush(); }

 private:
  ~ClosedTemporaryStream() = default;
};

TEST(QuarantinedOutputStream, RetainsPreCopyFailureAfterTargetClose)
{
  RefPtr<FinishFailureTarget> target = new FinishFailureTarget();
  RefPtr<ClosedTemporaryStream> stream = new ClosedTemporaryStream(target);
  const nsCString data("Subject: failed temp flush\r\n\r\nExact body.\r\n"_ns);
  uint32_t written = 0;
  ASSERT_EQ(NS_OK, stream->Write(data.get(), data.Length(), &written));
  ASSERT_EQ(data.Length(), written);
  ASSERT_EQ(NS_OK, stream->CloseTemporaryStream());
  const nsresult original = stream->TemporaryFlushStatus();
  ASSERT_TRUE(NS_FAILED(original));
  ASSERT_EQ(original, stream->Finish());
  EXPECT_TRUE(stream->IsTargetUntouchedAndClosed());
  EXPECT_TRUE(target->bytes.IsEmpty());
  EXPECT_EQ(0u, target->finishCalls);
  EXPECT_EQ(1u, target->closeCalls);
  EXPECT_EQ(original, stream->Close());
  EXPECT_EQ(original, stream->Finish());
  EXPECT_EQ(original, stream->StreamStatus());
  EXPECT_EQ(1u, target->closeCalls);
}

TEST(QuarantinedOutputStream, RetainsUnwrittenTargetCloseFailure)
{
  RefPtr<FinishFailureTarget> target = new FinishFailureTarget();
  target->closeResult = NS_ERROR_FILE_ACCESS_DENIED;
  RefPtr<nsQuarantinedOutputStream> stream =
      new nsQuarantinedOutputStream(target);
  ASSERT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->Close());
  EXPECT_FALSE(stream->IsTargetUntouchedAndClosed());
  EXPECT_TRUE(target->bytes.IsEmpty());
  EXPECT_EQ(0u, target->finishCalls);
  EXPECT_EQ(1u, target->closeCalls);
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->Finish());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->StreamStatus());
  EXPECT_EQ(NS_ERROR_FILE_ACCESS_DENIED, stream->Close());
  EXPECT_EQ(1u, target->closeCalls);
}

}  // namespace

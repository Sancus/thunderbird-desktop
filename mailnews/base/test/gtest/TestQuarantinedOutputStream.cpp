/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "mozilla/RefPtr.h"
#include "nsQuarantinedOutputStream.h"
#include "nsString.h"

namespace {

// Injects only the inner result; the wrapper and temporary-file I/O are real.
class FinishFailureTarget final : public nsIOutputStream,
                                  public nsISafeOutputStream {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  NS_IMETHOD Close() override { return NS_OK; }
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

 private:
  ~FinishFailureTarget() = default;
};

NS_IMPL_ISUPPORTS(FinishFailureTarget, nsIOutputStream, nsISafeOutputStream)

TEST(DISABLED_QuarantinedOutputStream, RetainsInnerFinishFailure)
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

}  // namespace

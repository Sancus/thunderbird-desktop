#include "gtest/gtest.h"
#include "nsString.h"
#include "HeaderReader.h"
#include "nsTArray.h"
#include "IHeaderBlock.h"
#include "MailHeaderParsing.h"
#include "mozilla/Components.h"
#include "mozilla/RefPtr.h"
#include "nsCOMPtr.h"
#include "nsIMimeConverter.h"
#include "nsISupportsImpl.h"
#include "nsMsgMessageFlags.h"

// Invocation:
// $ ./mach gtest "TestMsgHeaderReader.*"

TEST(TestMsgHeaderReader, Basic)
{
  struct hdr {
    nsCString name;
    nsCString rawValue;
  };

  struct {
    nsCString raw;
    nsTArray<hdr> expected;
    bool isComplete;     // expect to find complete header block?
    nsCString leftOver;  // Data which should be left unprocessed.
  } testMsgs[] = {
      // Simple case works?
      {
          "Message-ID: one\r\n"
          "To: alice@example.com\r\n"
          "\r\n"
          "Body here. HeaderReader should have stopped by now.\r\n"
          "Note: this line looks like a header, but it isn't!\r\n"_ns,
          {
              {"Message-ID"_ns, "one"_ns},
              {"To"_ns, "alice@example.com"_ns},
          },
          true,
          "Body here. HeaderReader should have stopped by now.\r\n"
          "Note: this line looks like a header, but it isn't!\r\n"_ns,
      },
      // Handle folded header values correctly?
      {
          "To: bob@example.com\r\n"
          "Subject: Do\r\n"
          " we\r\n"
          " handle\r\n"
          "\tfolded\r\n"  // Can fold with tabs too.
          " fields OK?\r\n"
          "Message-ID: two\r\n"
          "\r\n"
          "...message body here...\r\n"_ns,
          {
              {"To"_ns, "bob@example.com"_ns},
              {"Subject"_ns,
               "Do\r\n we\r\n handle\r\n\tfolded\r\n fields OK?"_ns},
              {"Message-ID"_ns, "two"_ns},
          },
          true,
          "...message body here...\r\n"_ns,
      },
      // Handle no whitespace after colon?
      {
          "Foo:bar\r\n"
          "\r\n"_ns,
          {
              {"Foo"_ns, "bar"_ns},
          },
          true,
          ""_ns,
      },
      // Folding with no text on first line?
      // (I _think_ this is legal...)
      {
          "Foo: \r\n"
          " bar\r\n"
          "\r\n"_ns,
          {
              {"Foo"_ns, "\r\n bar"_ns},
          },
          true,
          ""_ns,
      },
      // Folded line with no end of header block.
      // Input could be truncated. So we don't want this to output any headers
      // (The missing next line could be folded or not - we just don't know).
      {
          "Foo:\r\n"
          " bar\r\n"
          " wibble\r\n"_ns,
          {},
          false,
          "Foo:\r\n bar\r\n wibble\r\n"_ns,
      },
      // Ignore incomplete lines as expected?.
      {
          "Foo: bar\r\n"
          "Wibble: this is a part"_ns,  // ... "ial line".
          {
              {"Foo"_ns, "bar"_ns},
          },
          false,
          "Wibble: this is a part"_ns,
      },
      // Ignore incomplete folded lines?
      {
          "Foo: bar\r\n"
          "Wibble: this\r\n"
          " value is not co"_ns,  // ... "mplete".
          {
              {"Foo"_ns, "bar"_ns},
          },
          false,
          "Wibble: this\r\n value is not co"_ns,
      },
      // Handle empty input without crashing?
      {
          ""_ns,
          {},
          false,
          ""_ns,
      }};

  for (size_t i = 0; i < std::size(testMsgs); ++i) {
    auto const& t = testMsgs[i];
    // Collect all the headers.
    nsTArray<HeaderReader::Hdr> gotHeaders;
    HeaderReader rdr;
    auto handler = [&](HeaderReader::Hdr const& hdr) {
      gotHeaders.AppendElement(hdr);
      return true;  // Keep going.
    };

    // Simulate multiple passes over a growing buffer - we'll add a quarter
    // of the data each pass.
    for (uint32_t i = 1; i < 4; ++i) {
      // Encourage each pass to use different memory.
      nsCString fudge(t.raw.BeginReading(), i * t.raw.Length() / 4);
      rdr.Parse(fudge, handler);
    }

    // Last pass - give the reader the entire input.
    auto leftOver = rdr.Parse(t.raw, handler);

    // Did we get all the headers we expected?
    ASSERT_EQ(gotHeaders.Length(), t.expected.Length());
    for (size_t i = 0; i < t.expected.Length(); ++i) {
      auto const& expect = t.expected[i];
      auto const& got = gotHeaders[i];
      ASSERT_EQ(expect.name, nsCString(got.Name(t.raw)));
      ASSERT_EQ(expect.rawValue, nsCString(got.RawValue(t.raw)));
    }

    // Correctly detected the end of the header block?
    ASSERT_EQ(t.isComplete, rdr.IsComplete());

    // Make sure processing stopped where expected.
    ASSERT_EQ(t.leftOver, nsCString(leftOver));
  }
}

// Check that callback can halt processing, and that it can be correctly
// resumed.
TEST(TestMsgHeaderReader, Stop)
{
  // We'll stop each time we find a header name containing "STOP".
  struct {
    nsCString raw;
    int expectedCount;   // Number of headers we expect to find.
    int expectedPasses;  // Number of passes we expect to run.
  } testMsgs[] = {
      {"foo: bar\r\n\r\n"_ns, 1, 1},
      {"Message-ID: one\r\n"
       "STOP: pause here please\r\n"
       "foo-One: nothing to see here...\r\n"
       "foo-Two: still nothing...\r\n"
       "\r\n"_ns,
       4, 2},
      {"A: eh\r\n"
       "B: bee\r\n"
       "STOP_1: pause here.\r\n"
       "C: sea\r\n"
       "STOP_2: another pause.\r\n"
       "E: eee\r\n"
       "STOP_3: last one.\r\n"
       "\r\n"_ns,
       7, 3},
  };

  for (size_t i = 0; i < std::size(testMsgs); ++i) {
    auto const& t = testMsgs[i];
    HeaderReader rdr;
    int gotCount = 0;
    auto handler = [&](HeaderReader::Hdr const& hdr) {
      ++gotCount;
      return nsCString(hdr.Name(t.raw)).Find("STOP") == kNotFound;
    };

    int passes = 0;
    // All our examples have a complete header block.
    while (!rdr.IsComplete()) {
      rdr.Parse(t.raw, handler);
      ++passes;
    }
    ASSERT_EQ(gotCount, t.expectedCount);
    ASSERT_EQ(passes, t.expectedPasses);
    ASSERT_TRUE(rdr.IsComplete());
  }
}

// These tests exercise the parser used by native local insertion, rather than
// supplying an Attachment flag to a database or view fixture.
TEST(TestMsgHeaderReader, RawMailHeadersMimeAttachment)
{
  nsCOMPtr<nsIMimeConverter> converter =
      mozilla::components::MimeConverter::Service();
  ASSERT_TRUE(converter);
  struct {
    nsCString headers;
    uint32_t expectedFlags;
    nsCString expectedCharset;
  } cases[] = {
      {"Content-Type: multipart/mixed; boundary=parts; charset=utf-8\r\n"_ns,
       nsMsgMessageFlags::Attachment, "utf-8"_ns},
      {"Content-Type: MuLtIpArT/MiXeD;\r\n boundary=parts\r\n"
       "X-Mozilla-Status: 0005\r\n"_ns,
       nsMsgMessageFlags::Attachment | nsMsgMessageFlags::Read |
           nsMsgMessageFlags::Marked,
       ""_ns},
      {"Content-Type: text/plain; charset=utf-8\r\n"_ns, 0, "utf-8"_ns},
      {"Content-Type: multipart/alternative; boundary=parts\r\n"
       "X-Mozilla-Status: 0005\r\n"_ns,
       nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked, ""_ns},
  };
  for (const auto& test : cases) {
    nsCString raw =
        "From: Sender <sender@example.invalid>\r\n"
        "To: recipient@example.invalid\r\n"
        "Message-ID: <mime-flags@example.invalid>\r\n"
        "Subject: MIME flags\r\n"_ns +
        test.headers + "\r\nBody: not a header\r\n"_ns;
    RawHdr parsed = ParseRawMailHeaders(raw);
    EXPECT_EQ(parsed.flags, test.expectedFlags);
    EXPECT_EQ(parsed.charset, test.expectedCharset);
    EXPECT_EQ(parsed.messageId, "mime-flags@example.invalid"_ns);
    EXPECT_EQ(parsed.subject, "MIME flags"_ns);
    EXPECT_EQ(parsed.sender, "Sender <sender@example.invalid>"_ns);
    EXPECT_EQ(parsed.recipients, "recipient@example.invalid"_ns);
    EXPECT_TRUE(parsed.messageSize.isNothing());
    EXPECT_TRUE(parsed.storeToken.isNothing());
  }
}

TEST(TestMsgHeaderReader, RawMailHeadersStatusAndReplyFlags)
{
  nsCOMPtr<nsIMimeConverter> converter =
      mozilla::components::MimeConverter::Service();
  ASSERT_TRUE(converter);
  struct {
    nsCString headers;
    nsCString subject;
    uint32_t expectedStatus;
  } cases[] = {
      // Stored runtime-only bits are masked; the decoded subject supplies
      // HasRe.
      {"X-Mozilla-Status: 00a7\r\n"_ns, "=?UTF-8?Q?Re=3A_Caf=C3=A9?="_ns,
       nsMsgMessageFlags::Read | nsMsgMessageFlags::Replied |
           nsMsgMessageFlags::Marked | nsMsgMessageFlags::HasRe},
      // The subject also clears a stale stored HasRe bit.
      {"X-Mozilla-Status: 0015\r\n"_ns, "Cafe"_ns,
       nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked},
      // A valid Mozilla status takes precedence over Berkeley Status.
      {"X-Mozilla-Status: 0005\r\nStatus: U\r\n"_ns, "Cafe"_ns,
       nsMsgMessageFlags::Read | nsMsgMessageFlags::Marked},
      {"X-Mozilla-Status: zzzz\r\nStatus: R\r\n"_ns, "Cafe"_ns,
       nsMsgMessageFlags::Read},
      {"Status: RN\r\n"_ns, "Cafe"_ns, 0},
  };
  for (const auto& test : cases) {
    nsCString raw = "Content-Type: multipart/mixed; boundary=parts\r\n"_ns +
                    test.headers + "Subject: "_ns + test.subject +
                    "\r\n\r\n"_ns;
    RawHdr parsed = ParseRawMailHeaders(raw);
    EXPECT_EQ(parsed.flags,
              nsMsgMessageFlags::Attachment | test.expectedStatus);
    EXPECT_EQ(parsed.flags & nsMsgMessageFlags::RuntimeOnly, 0u);
    EXPECT_EQ(parsed.subject, test.expectedStatus & nsMsgMessageFlags::HasRe
                                  ? "Caf\xc3\xa9"_ns
                                  : "Cafe"_ns);
  }
}

namespace {

// Only the AsRaw transport boundary is controlled; header parsing remains real.
class RawTestHeaderBlock final : public IHeaderBlock {
 public:
  NS_DECL_ISUPPORTS

  explicit RawTestHeaderBlock(const nsACString& raw, nsresult result = NS_OK)
      : mRaw(raw), mResult(result) {}

  NS_IMETHOD GetNumHeaders(uint32_t*) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  NS_IMETHOD Name(uint32_t, nsACString&) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  NS_IMETHOD Value(uint32_t, nsACString&) override {
    return NS_ERROR_NOT_IMPLEMENTED;
  }
  NS_IMETHOD AsRaw(nsACString& raw) override {
    ++calls;
    raw = mRaw;
    return mResult;
  }

  uint32_t calls{0};

 private:
  ~RawTestHeaderBlock() = default;
  nsCString mRaw;
  nsresult mResult;
};

NS_IMPL_ISUPPORTS(RawTestHeaderBlock, IHeaderBlock)

}  // namespace

TEST(TestMsgHeaderReader, HeaderBlockMimeAttachment)
{
  nsCOMPtr<nsIMimeConverter> converter =
      mozilla::components::MimeConverter::Service();
  ASSERT_TRUE(converter);
  nsCString raw =
      "Message-ID: <header-block@example.invalid>\r\n"
      "From: Sender <sender@example.invalid>\r\n"
      "To: recipient@example.invalid\r\n"
      "Cc: cc@example.invalid\r\n"
      "Reply-To: reply@example.invalid\r\n"
      "References: <parent@example.invalid>\r\n"
      "Date: Tue, 01 Jan 2019 00:00:00 +0000\r\n"
      "Content-Type: multipart/mixed; boundary=parts; charset=utf-8\r\n"
      "X-Mozilla-Status: 0005\r\n"
      "Subject: Re: Header block\r\n\r\n"_ns;
  RawHdr direct = ParseRawMailHeaders(raw);
  RefPtr<RawTestHeaderBlock> headers = new RawTestHeaderBlock(raw);
  RawHdr wrapped = ParseHeaderBlock(headers);
  EXPECT_EQ(headers->calls, 1u);
  EXPECT_EQ(wrapped.flags,
            nsMsgMessageFlags::Attachment | nsMsgMessageFlags::Read |
                nsMsgMessageFlags::Marked | nsMsgMessageFlags::HasRe);
  EXPECT_EQ(wrapped.flags, direct.flags);
  EXPECT_EQ(wrapped.subject, "Header block"_ns);
  EXPECT_EQ(wrapped.messageId, direct.messageId);
  EXPECT_EQ(wrapped.subject, direct.subject);
  EXPECT_EQ(wrapped.sender, direct.sender);
  EXPECT_EQ(wrapped.recipients, direct.recipients);
  EXPECT_EQ(wrapped.ccList, direct.ccList);
  EXPECT_EQ(wrapped.replyTo, direct.replyTo);
  EXPECT_EQ(wrapped.references, direct.references);
  EXPECT_EQ(wrapped.date, direct.date);
  EXPECT_EQ(wrapped.charset, direct.charset);
  EXPECT_TRUE(wrapped.messageSize.isNothing());
  EXPECT_TRUE(wrapped.storeToken.isNothing());

  // Even if AsRaw writes bytes before failing, no partial header is returned.
  RefPtr<RawTestHeaderBlock> failed =
      new RawTestHeaderBlock(raw, NS_ERROR_FILE_ACCESS_DENIED);
  RawHdr blank = ParseHeaderBlock(failed);
  EXPECT_EQ(failed->calls, 1u);
  EXPECT_EQ(blank.flags, 0u);
  EXPECT_EQ(blank.key, nsMsgKey_None);
  EXPECT_TRUE(blank.messageId.IsEmpty());
  EXPECT_TRUE(blank.subject.IsEmpty());
  EXPECT_TRUE(blank.sender.IsEmpty());
  EXPECT_TRUE(blank.recipients.IsEmpty());
  EXPECT_TRUE(blank.references.IsEmpty());
  EXPECT_TRUE(blank.charset.IsEmpty());
  EXPECT_EQ(blank.date, 0);
  EXPECT_TRUE(blank.messageSize.isNothing());
  EXPECT_TRUE(blank.storeToken.isNothing());
}

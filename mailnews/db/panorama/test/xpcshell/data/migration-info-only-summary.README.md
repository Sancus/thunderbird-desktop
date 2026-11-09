`migration-info-only-summary.msf` is genuine legacy MDB output. In an ordinary
Thunderbird profile with Panorama disabled, a synthetic offline IMAP account
(`imap.invalid`) created its empty `Drafts` folder with
`createClientSubfolderInfo`, set `onlineName`/`UIDValidity`, and committed the
open database with `kCompressCommit`. The compress commit wrote only the
folder-info table; `nsMsgDatabase` recreates the all-headers and all-threads
tables when it opens such a summary. The same shape occurs in real profiles.
It contains no message, account credential or user data.

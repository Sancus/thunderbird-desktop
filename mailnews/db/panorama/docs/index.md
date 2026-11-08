# New Database (AKA Panorama)

```{pull-quote}
**panorama** *n.* An unbroken view of an entire surrounding area.
```

Panorama is the working name of Thunderbird's new global message database. All folders and messages
will be stored in a single database, instead of one database per folder as currently happens.

Code for updating the front end's message list is also within scope.

```{warning}
Panorama is under development. It is not live and there are currently no user-facing parts. Feel
free to explore, but you do so at your own risk.
```

## Enabling it

The Panorama code is compiled in when the `MOZ_PANORAMA` compile-time flag is set.
This happens automatically on the nightly channel (i.e. comm-central) only.

`MOZ_PANORAMA` can be used for conditional blocks in C++ code, moz.build files, and other places
where preprocessing happens.

To use Panorama at runtime (instead of the old mork databases), set the pref `mail.panorama.enabled`
to true.

To run tests:

```
$ ./mach mochitest --setpref mail.panorama.enabled=true ....
$ ./mach xpcshell-test --setpref mail.panorama.enabled=true ....
```

## Restore a complete migration backup

The same procedure applies on Linux, macOS and Windows. It restores the selected
profile and every external store in its verified migration backup to their
approved original locations. The archive remains intact. Current data displaced
by restoration is retained separately, including messages written after backup.

Use the same Thunderbird trial build for every invocation below. Unix examples
use `thunderbird`; on macOS use the executable inside your installed app, such as
`/Applications/Thunderbird.app/Contents/MacOS/thunderbird`. Quote executable and
absolute paths that contain spaces. On Windows, use PowerShell's `&` with your
installed `thunderbird.exe` and native absolute paths; for example, replace these
paths to list the required roots without approving replacement:

```powershell
& 'C:\Program Files\Mozilla Thunderbird\thunderbird.exe' --new-instance --profile 'C:\Profiles\Trial' --panorama-restore 'D:\Backups\Trial'
```

Use that platform's executable and paths for approval, recovery and both ordinary
invocations too. The restore flags and process sequence are identical.

### Select and approve the complete operation

Close Thunderbird and other writers to the selected profile and its external
stores. Keep the same profile and local-profile directories. Retain the complete
archive and any matching saved journal or archive required by its selector.
A missing or conflicting dependency is an error to resolve before replacement;
saved backend/version, database UUID, import-token and source-map identities are
preserved. Use the application-generated request; do not write or edit its JSON.

First request the backup without approval flags to list the complete required
root set. This refuses replacement:

```sh
thunderbird --new-instance --profile /absolute/profile --panorama-restore /absolute/backup
```

Review the listed destinations before approving their replacement. Repeat with
one `--panorama-restore-approve` for **every** exact root, including the selected
profile. Approval covers replacing
those roots' contents while retaining their current data. An omitted, extra,
changed, linked or overlapping root causes refusal.

For example, replace these absolute paths with the exact listed roots; repeat
the approval option for any additional root:

```sh
thunderbird --new-instance --profile /absolute/profile \
  --panorama-restore /absolute/backup \
  --panorama-restore-approve /absolute/profile \
  --panorama-restore-approve /absolute/mail-mbox \
  --panorama-restore-approve /absolute/mail-maildir
```

This **request process** verifies the archive and complete root/dependency
approval, saves the fixed profile-specific sibling request, and quits. It does
not restore live data. Keep the archive digest and all reported retained paths.
Keep enough writable space for staged copies and displaced current data. Staged
restore copies stay outside archive/live roots. On Windows, native-owned retained
originals may use an exclusive same-volume retirement directory inside an
approved live root. Never create, move or change these custody paths yourself.

### Restore, quit and restart

After the request process has exited, run the same profile without restore
options:

```sh
thunderbird --new-instance --profile /absolute/profile
```

This **restoration-only process** retains the normal selected-profile lock and
keeps account/database writers closed. Its synchronous native operation verifies
and stages every archive root, holding source/output custody through copy, flush
and verification. It captures current contents at this closed-writer boundary,
including newer children created since request preparation, and retains them
before installation. Selected directories and live lock files remain in place.
Every installed root is checked against its saved bytes and metadata.

Treat restoration as incomplete until all roots have a verified terminal result.
One restored root does not make a partially restored profile usable. The process
settles its file operations and quits without normal mail windows. Preserve its
outcome and the recorded archive, progress, stage and displaced-data locations,
including the sibling `panorama-migration-<profile-leaf>` work directory.
Settlement removes pending `restore.json`, retaining fixed `restore-current.json`
and immutable `restore-<id>-<generation>.complete.json`. Preserve these audits;
never select one by newest timestamp, overwrite, repair or remove it.

After verified full restoration and exit, run the same ordinary command **again**
in a fresh process. Before writers start, it revalidates the real native audit
and completes native settlement; restored preferences are read afresh. Check the
backend, accounts, folders and messages, including external stores. Normal
version, selector, journal and native-receipt checks still apply. Keep the archive
and retained newer-data trees until their contents have been checked and their
disposal is explicitly chosen. Do not repeat the new-request flags on every
startup or automatically combine these three process lifetimes.

### Retry, interruption and full rollback

On error, cancellation or process interruption, retain the first error and every
reported file/directory. Keep archive, progress, stages and partially displaced
contents at their recorded paths. An unfinished operation blocks ordinary startup
even with Panorama disabled. Never edit IDs, progress, generations or receipts,
or delete guards, selectors, journals or audits, to force startup.

Stop all writers. To recover the exact retained operation, choose **one** action:

```sh
thunderbird --new-instance --profile /absolute/profile --panorama-restore-retry
# Or return all displaced current roots to their approved original paths:
thunderbird --new-instance --profile /absolute/profile --panorama-restore-rollback
```

These actions are mutually exclusive with a new restore request. This process
rechecks identity, records only the supported action, and quits. Retry requires
the original verified archive and dependencies; if no root was changed yet, it
keeps that attempt's staging and exact `restore-<id>-<n>.failed.json` ledger and
prepares the same approved operation in fresh owner-only staging. Rollback can
use the native-retained verified manifest, stage, saved-before data and custody
when the original after-input is unavailable. Missing or conflicting retained
proof refuses; JSON or timestamps alone grant no authority. After the request
exits, run the ordinary command above; it recovers, settles and quits. Only
complete verified settlement allows a further ordinary process. Other changed,
unknown or mixed states block.

Full rollback first copies and verifies each current root, including data
written since restoration, into `newer-<n>` beside its saved copy, then returns
every saved root without mixing attempts. Failed rollback keeps its guard, first
error and all data. Archive and retained evidence are never discarded.

### Validation

From the Firefox source root after a normal Debug build, the registered full-file
startup test exercises real profile selection, external stores, restoration-only
exit, fresh restart and recovery outcomes:

```text
python3 ./mach --no-interactive marionette-test --headless --log-raw=- --gecko-log=- comm/mail/test/marionette/test_panorama_startup_backup.py
```

## Logging

The `panorama` log emits a bunch of relevant stuff.
But you might also want `mozStorage`, which logs the lower-level sqlite stuff.

For example:
```
$ export MOZ_LOG="panorama:4,mozStorage:4"
```

## The Plan

1. Implement the global database (at least enough of it)
2. Implement the legacy interfaces to run against Panorama rather than mork.
  This boils down to implementing Panorama-aware versions of:
    - `nsIMsgDatabase` (there are some derived classes for various protocols, but really easiest to
      think of them all as one).
    - `nsIMsgDBHdr` - represents a single message, in a single folder.
    - `nsIMsgThread` - The model for threaded conversations, within a folder.
    - `nsIMsgDBService` - responsible for opening and caching databases.
    - `nsIFolderInfo` - persists assorted folder settings in the database.
3. Fix whatever needs fixing to get the existing stuff up and running against Panorama.
4. Solid migration path from old system
5. Use fancy new Panorama features and phase out the legacy interfaces
    - LiveViews etc.
    - Replace gloda by integrating full-text searching into Panorama.
6. Remove the legacy database code and interfaces completely.

There is a _lot_ of scope to simplify huge parts of the codebase, while adding new functionality
which cannot currently be supported. Proper global conversation views, for one.

## Key Components

### DatabaseCore

[nsIDatabaseCore](https://searchfox.org/comm-central/source/mailnews/db/panorama/public/nsIDatabaseCore.idl)
(see also [nsIMsgDBService](https://searchfox.org/comm-central/source/mailnews/db/msgdb/public/nsIMsgDatabase.idl)),
[DatabaseCore.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/DatabaseCore.h),
[DatabaseCore.cpp](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/DatabaseCore.cpp)

This is the single entry point to access the database. It can give you access to the other database
components:

From JS:

```js
const database = Cc["@mozilla.org/mailnews/database-core;1"].getService(Ci.nsIDatabaseCore);
const folders = database.folderDB;
const messages = database.messageDB;
```

From C++:

```c++
nsCOMPtr<nsIDatabaseCore> database = components::DatabaseCore::Service();
nsCOMPtr<nsIFolderDatabase> folders = database->GetFolderDB();
nsCOMPtr<nsIMessageDatabase> messages = database->GetMessageDB();
```

If Panorama is enabled, `DatabaseCore` will be started automatically by the initialisation of the
account manager. This includes overriding the default database server XPCOM registration.

If you want to use it before the account manager (e.g. in a test), call `DatabaseCore.startup()`.

### FolderDatabase

[nsIFolderDatabase](https://searchfox.org/comm-central/source/mailnews/db/panorama/public/nsIFolderDatabase.idl),
[FolderDatabase.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/FolderDatabase.h),
[FolderDatabase.cpp](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/FolderDatabase.cpp)

Access to folders and their properties. The front-end code will have read-only access (`Folder`
objects) by methods `getFolderById` and `getFolderByPath`, and event listeners. Modifications to
folders should be through function calls to the back end.

### Folder

[nsIFolder](https://searchfox.org/comm-central/source/mailnews/db/panorama/public/nsIFolder.idl),
[Folder.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/Folder.h),
[Folder.cpp](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/Folder.cpp)

Each row in the folders table has a corresponding `Folder` object which is kept up-to-date at all
times. Outside of `FolderDatabase`, `Folder` is a read-only object and has no methods that can cause
anything to happen.

The `id` and `path` properties uniquely identify a `Folder`. Code should not attempt to manipulate
the `path` to find other folders.

### MessageDatabase

[nsIMessageDatabase](https://searchfox.org/comm-central/source/mailnews/db/panorama/public/nsIMessageDatabase.idl),
[MessageDatabase.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/MessageDatabase.h),
[MessageDatabase.cpp](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/MessageDatabase.cpp)

Access to messages and their properties. Like `FolderDatabase`, changes to the data *should* go
through function calls on this object

### Message

[nsIMsgDBHdr](https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgHdr.idl),
[Message.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/Message.h),
[Message.cpp](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/Message.cpp)

Unlike `Folder`, `Message` objects implement an existing interface and can cause changes in the
database. This is likely to change once the old databases are switched off.

### PerFolderDatabase and FolderInfo

[nsIMsgDatabase](https://searchfox.org/comm-central/source/mailnews/db/msgdb/public/nsIMsgDatabase.idl),
[nsIDBFolderInfo](https://searchfox.org/comm-central/source/mailnews/db/msgdb/public/nsIDBFolderInfo.idl),
[PerFolderDatabase.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/PerFolderDatabase.h),
[PerFolderDatabase.cpp](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/PerFolderDatabase.cpp)

These classes exist to bridge the gap between legacy code, which expects one database per folder,
and the new single database. Mostly they just forward calls to the new database code (with added
context of the folder they represent) but there is a bit of data manipulation where the database we
want doesn't match the interfaces we have to support.

### LiveView

[nsILiveView](https://searchfox.org/comm-central/source/mailnews/db/panorama/public/nsILiveView.idl),
[LiveView.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/LiveView.h),
[LiveView.cpp](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/LiveView.cpp)
[LiveViewFilters.h](https://searchfox.org/comm-central/source/mailnews/db/panorama/src/LiveViewFilters.h),

A `LiveView` is so-called because represents a collection of messages that keeps itself up-to-date.
It is defined by zero or more `LiveViewFilter`s which narrow the scope of the view, e.g. to all
messages in a particular folder, or all messages with the ‘Important’ tag.

`LiveView` is intended for use by the front end, and before sending messages there it converts them
to plain JS objects instead of XPCOM objects, for performance reasons. Therefore a message obtained
from a `LiveView` is *not* live. However you can register a single JS listener to get updates.

### LiveViewDataAdapter

[LiveViewDataAdapter.mjs](https://searchfox.org/comm-central/source/mailnews/db/panorama/content/LiveViewDataAdapter.mjs)

`LiveViewDataAdapter` is a JS component for connecting a `LiveView` to a `TreeView`. It maintains a
sparse array of messages that is populated on demand.

## Conventions and guidelines

### Integer types

SQLite only provides one integer type (`INTEGER`), which size is determined
automatically by the database engine based on the value itself. This means we
cannot rely on it preventing us from e.g. storing a 64-bit integer where we
expect a 32-bit one. Therefore extra care should be applied when introducing new
code that writes and reads integers to and from the database.

Here are a few guidelines to follow:

* writing to, and reading from an integer column should use the same integer
  type
* when introducing a new integer value that doesn't exist in the legacy API (e.g.
  `folderId`), prefer 64-bit integers to minimize the risk of roll-over
* when using an integer value that already exists in the legacy API (e.g.
  `flags` or `priority`), prefer the type used by the public API (32-bit in both
  cases here) to minimise casts when setting and getting column values

Similarly, the SQLite C API only supports signed integers. This should be fine
as long as a we're careful to set and read values using the same types (e.g.
implicitly cast from `uint64_t` to `int64_t` when setting, and doing the
opposite when reading).

Technically speaking, it may not matter much which type we use when writing the
integer as long as it can be read as the intended type later on (e.g. writing as
`uint32_t` and reading as `int64_t`). However, using a consistent type for a
given column/value helps make the code easier to reason with and (hopefully)
reduce future issues such as integer roll-over. We'll probably eventually move
most integers we use to be written over 64 bits, but this will take time (see
the `nsMsgKeys` issue below, as an example).

## Known issues

This is a list of issues we know we'll have to confront at some point, but we're ignoring for now.

### nsMsgKeys are only 32bit

32 bits probably aren't enough for a global database, especially if there's a lot of turnover. There
could be some clever ID reclamation system, but really we should just bite the bullet and go to 64
bits. Simply switching to a 64bit `nsMsgKey` is fine for the new code, but could cause a lot of
issues in old code.

For now we'll probably leave the nsMsgKey at 32 bits while Panorama is in it's development phase.

### Definition of `nsMsgKey_None` as 0xFFFFFFFF.

`nsMsgKey_None` is currently defined as `0xFFFFFFFF` (AKA `uint32_t` 4294967295).

A value of `0` is probably better for Panorama (SQL databases tend not to use `0` for auto-assigned
primary keys).

In any case, a special value of `0xFFFFFFFF` is no good for a 64bit nsMsgKey.

The C++ side is probably easy enough to deal with, but there are a lot of `0xFFFFFFFF`s out there in
javascript, and likely a bunch of `-1`s to pick through too.

For now, Panorama can probably fudge things by massaging any potentially-None nsMsgKeys it returns
from it's API, but at some point we'll need to deal with it.

### IMAP/News won't work.

Currently IMAP and News use the message UID assigned by the server as the primary database key.
This is no good for a global database as those keys are only unique within a single folder.

The fix is to track server-assigned IDs separately, and let the database assign it's own keys.

* [Bug 1806770](https://bugzilla.mozilla.org/show_bug.cgi?id=1806770) - IMAP shouldn't use UID as
message key

### Reliance on detached nsIMsgDBHdr objects

Mork supports editing database rows which are not attached to a table in the DB. Sqlite does not.
The current code relies heavily upon this fact when adding messages to the database.

The main approach here is to replace the use of a detached nsIMsgDBHdr with a "here's all the data"
object. Often the message fields are known when a message entry is created, so we can collect it
before going to the database.

* [Bug 1952094](https://bugzilla.mozilla.org/show_bug.cgi?id=1952094) - Stop using detached
nsIMsgDBHdr objects

It's also an issue for message filtering: the filters operate upon `nsIMsgDBHdr` objects, but often
(at least for POP3 incoming messages) these objects are not in the database. The filter runs, and
_then_ the message is added to a database (depending upon which folder it ends up in). This also
causes big complications with local storage - which doesn't have the explicit concept of a detached
message.

We can fool the existing filter logic by implementing another `nsIMsgDBHdr` object which just stores
fields locally and has no database connection. But the filter actions (move/copy/delete etc) and
local message store will need work.

### Dangling folders

The current code tends to create folders lazily, and there's an assumption that child folders can be
created before their parents.

This is silly, and it'd be much much simpler for everyone concerned if folders were created as a
part of sensible folder hierarchy from the start.

Ideally, each folder hierarchy would be initially created by the `nsIMsgIncomingServer` object that
was responsible for them.

As folders were added and removed (via user operations, or via slower network-based discoveries),
child folders should be created by their parent.

TODO: talk about folder URIs here.

* [Bug 1679333](https://bugzilla.mozilla.org/show_bug.cgi?id=1679333) - Remove support for dangling
(unparented) folders

## Things to think about

- How to integrate full-text indexing (of message body)?
  - How to handle different languages? Proper stemming/tokenisation needs to be language-aware...
- How to represent messages appearing in multiple folders?
  - do any protocols support per-folder-per-message flags?
    i.e. if you set "Read" on a message, do instances of that message in other folders also
    appear "Read" or do they have their own flags?
- How to handle add-on API requirements.
  - Want to attach arbitrary values to messages, folders etc... but don't want the free-for-all
    of the legacy database.
  - Ability to register extra message headers to parse and retain in the database
    (the database only stores data from a few headers, and the data is not verbatim, it's
    cooked in all kinds of ways).

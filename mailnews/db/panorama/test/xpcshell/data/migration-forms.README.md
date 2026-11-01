# Genuine nondefault-form migration inputs

These files are unchanged outputs of the existing native MDB writer in
`MigrationMorkFixtures.DictionaryFormArtifact` and `RowFormArtifact` from
mi081-native-003, based on comm-central 1eb24dd0e20a75a89dfb90b6c8029c2623789438.
The reference-only producer is not part of the shipped application.

`migration-forms.json` contains literal semantic expectations specified before
production. Runtime physical tokens and hashes are separate measurements:

| Input | Bytes | SHA-256 |
| --- | --- | --- |
| migration-dictionary-form.mork | 284 | b400b4d2ab8427ed267799091b49de2f125eabc6a20a231e75ee370bfbf909ff |
| migration-row-form.mork | 1454 | 0ba6ed5c6c81a213f2afc26cf41f848f88de00205a46946f65180200ab6d31d4 |

For both inputs, measured column-space tokens 80/81/82/83/84/85 name the
literal scope/table kind/presentEmpty/Payload/absentValue/UTF-8 strings.
The dictionary input uses value-space alias 81; these two spaces are distinct.
Its raw UTF-8 payload is `dictionary é (raw)\$`, with form 85, linked from row1.
The default-form empty cell remains present; absentValue has no row cell.

Both writers committed and closed the real file before a distinct frozen native
reader opened it. The row-form native roundtrip and independent retrieved
readback passed. The dictionary native roundtrip **failed**: its reader returned
form0 instead of measured UTF-8 form85. That original failure remains preserved;
no old result is relabeled. The saved dictionary bytes nevertheless contain the
intended form and exact escaped UTF-8 payload. The migration-only scope uses
those genuine bytes directly, without requiring a repair of the discarded reader.

The retained strict structural and summary readers currently reject these forms
with exact UNSUPPORTED_MORK offsets. Tests require that refusal before any
partial result and preserve original buffer/file bytes. These fixtures provide
unsupported-input evidence; they do not claim positive import of nondefault
forms, native reader correctness, full grammar support, or startup activation.

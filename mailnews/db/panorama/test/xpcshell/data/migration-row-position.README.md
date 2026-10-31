This is genuine MDB output from `MigrationMorkFixtures.RowPositionArtifact`,
run by the ordinary native gtest harness on base
`1eb24dd0e20a75a89dfb90b6c8029c2623789438` plus the reference-only producer
input preserved in `mi081-native-002`. No Mork engine source was changed.

The producer committed four scoped rows, moved row 1 from position 0 to 2,
committed again, closed the writer and reopened the file frozen. The fourth
row is an unchanged control: the engine's incremental change budget is
`rowCount / 4`. Literal semantics are in `migration-row-position.json`;
physical scope/column tokens were measured separately. The file is 305 bytes,
SHA256 `02a2c85c0b3ceedd9f42f3cd2f04df84cd4b2795162c4929f187346ff445c4ea`.

The retained strict reader currently refuses the native `!2` move. These tests
require that refusal before a partial/stale snapshot can escape. This is a
real grammar input for future reader support, not a positive mail import or
startup/activation qualification. Existing summary/body, References, book and
cache fixtures remain unchanged. The reference producer is not a shipped or
runtime dependency.

## MODIFIED Requirements

### Requirement: The chat agent gets agent commands only
The registry SHALL be able to build an in-process MCP tool set for the chat agent that contains the L0 reads and the validated agent writes (including `source.record`, `courses.offer`, `canvas.capture`, `course.map`, `quizzes.read`, `assignment.saved`, `materials.saved`, `items.classify` and `assessment.files`), and no owner-only command; `course.import` SHALL NOT be in it, because course documents are built by code (see `layered-sync`), and `check.resolve` SHALL be owner-only. It SHALL NOT contain `sync.run` (sync is started only by the owner, #128) or `audit.record`, so an agent cannot record an action or a confirmation. The MCP stdio server SHALL list the same commands. Calls through it SHALL run with an agent context that can never carry owner authority, whatever the input says.

#### Scenario: Tool list
- **WHEN** the chat agent's tool list is built
- **THEN** it contains `autonomy.check` and `source.record` and does not contain `audit.record`, `sync.run`, any `browser.*` command, `course.import`, `check.resolve`, or any autonomy settings, course selection or planning settings command; MCP stdio lists the same

## ADDED Requirements

### Requirement: Generated CLI keeps one envelope
Commander subcommands SHALL dispatch through the registry. JSON mode SHALL print exactly one envelope on stdout with diagnostics on stderr. Owner-only commands (policy, grant, owner annotations, planning settings) SHALL require a trusted terminal; non-TTY calls SHALL get a safe refusal and SHALL never prompt for credentials or invent approval.

#### Scenario: Agent attempts an owner command
- **WHEN** a non-TTY caller invokes `grant.record`
- **THEN** it receives a safe refusal and no grant is stored

## REMOVED Requirements

### Requirement: Generated CLI preserves Q1 syntax
**Reason**: Decision #100 removes `src/quiz/`; the `quiz` commands go with it. The non-Q1 parts of this requirement continue as "Generated CLI keeps one envelope".
**Migration**: Quizzes are read and answered by the agent in the resident browser; permission checks and audit use `assessment-autonomy`.

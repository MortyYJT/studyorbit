## ADDED Requirements

### Requirement: Framework references come from the institution's framework source
The `handbook` reference platform SHALL refer to the active institution's framework source. Parsing of framework rows and components, the prompt clauses about citing them and quoting their rows, and the reason texts about them SHALL come from that framework source; the existing Handbook requirements of this capability SHALL be the `unimelb` framework source's behaviour, unchanged. When the institution has no framework source, the prompt SHALL omit framework clauses and components, and a `handbook` reference SHALL be a validation issue as a reference to a source that was not collected.

#### Scenario: UniMelb Handbook unchanged
- **WHEN** the UniMelb Handbook text contains the line `Project report\tWeek 10\t30%`
- **THEN** a component "Project report" with percentage 30 is parsed, as today

#### Scenario: Handbook reference without a framework
- **WHEN** the institution is `generic` and the model cites `{ platform: 'handbook', id: 'Exam' }`
- **THEN** validation reports that the source was not collected and the repair prompt is used

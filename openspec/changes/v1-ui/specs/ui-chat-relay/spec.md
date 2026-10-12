## ADDED Requirements

### Requirement: Hermes callable-interface spike before relay implementation
At M3 start a local spike SHALL verify an actual Hermes callable interface with synthetic input and record safe connection/authentication, request/result and failure behavior. The spike SHALL NOT assume MCP mounting supplies chat. If no usable interface exists, relay implementation SHALL stop and ask before choosing another interface or agent; independent M3 work SHALL continue. No model SDK or unapproved dependency SHALL be introduced.

#### Scenario: Hermes has no callable interface
- **WHEN** the spike cannot demonstrate a callable local interface
- **THEN** evidence and the decision needed are recorded, relay implementation stays blocked and no direct-model fallback is added

### Requirement: Chat crosses M2 and preserves external reasoning
The chat panel SHALL send messages and receive agent replies only through selected registered M2 relay contracts. The host SHALL relay to the verified local external agent; coursework SHALL NOT invoke a model. Before forwarding anything to Hermes, the trusted M2 server side SHALL redact or reject ALL outgoing text for classmates' names, emails and student numbers, including user messages, subjective/open-practice answers and selected context. Browser sanitization or prior ingestion redaction SHALL NOT substitute for this relay-boundary check. If safe redaction cannot be established, the request SHALL be rejected without forwarding. Relay input SHALL include only explicitly selected redacted context and SHALL exclude credentials, raw captures, capability and confirmation tokens. Agent output SHALL render safely; any proposed record write SHALL pass normal M2 validators, and prose SHALL NOT become owner consent or action authority.

#### Scenario: Synthetic chat and open practice
- **WHEN** the owner sends a message or an open-practice answer with selected cited context
- **THEN** the browser calls the M2 relay command, the local host relays bounded safe input and the UI displays the external response or explicit failure

#### Scenario: Personal data never reaches the Hermes receiving end
- **WHEN** synthetic classmates' name, email and student-number sentinels appear in each of a user message, subjective/open-practice answer and selected context, including a direct M2 request bypassing browser sanitization
- **THEN** receiving-end assertions at the synthetic Hermes adapter prove none of the original sentinels are received: safe requests contain only redacted text, and rejected/unsafe requests produce zero relay calls

#### Scenario: Agent requests privileged action
- **WHEN** agent prose asks to grant, approve, fill or submit an assessment
- **THEN** the message remains text and cannot mint owner authority or execute a privileged command

### Requirement: Bounded relay lifecycle and honest failure
The selected relay SHALL bound message/context/result sizes and define request identity, timeout/disconnect and any supported cancellation semantics. Pending, unavailable, rejected and uncertain replies SHALL remain distinct. The UI SHALL NOT invent agent success, automatically replay messages after ambiguous delivery or claim cancellation ended external execution without evidence. Persistent conversation layout/streaming SHALL await the recorded interface choice; M4 scheduling and notifications are excluded.

#### Scenario: Disconnect after message delivery
- **WHEN** the connection fails after a message may have reached Hermes
- **THEN** the UI marks its outcome uncertain and offers explicit reconciliation rather than silently sending it again

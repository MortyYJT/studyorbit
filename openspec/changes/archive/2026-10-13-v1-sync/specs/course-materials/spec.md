## ADDED Requirements

### Requirement: Download selected PDF materials privately
M1 SHALL download only verified PDF links from selected Canvas files/modules or Ed resources through authenticated page-context GETs confined to the provider origin and shared limiter. External/CDN redirects or unsafe URLs SHALL be coverage gaps, never followed by an external client or credential handoff. Raw PDFs SHALL remain under private `<data dir>/materials/` (default `.local/materials/`), ignored by Git, with owner-only permissions, safe generated paths, atomic writes and traversal/symlink confinement. Status/content/size SHALL be validated before extraction; malformed, oversized or interrupted downloads MUST NOT replace previous usable material or leak payloads/credentials in diagnostics.

#### Scenario: Selected material
- **WHEN** synthetic selected-course metadata links a same-origin PDF and the session is valid
- **THEN** a bounded counted GET atomically saves it privately without tokens or unsafe remote filenames

#### Scenario: External or unsafe link
- **WHEN** a link redirects to another origin or attempts a path/symlink escape
- **THEN** no external/escaping write occurs and a sanitized material gap is recorded

#### Scenario: Same-origin PDF outside API namespace
- **WHEN** synthetic selected Canvas file metadata links a PDF at same-origin `/courses/101/files/77/download`
- **THEN** the verified link can be downloaded with the browser session and shared limiter even though its path is outside `/api/v1`, without weakening JSON endpoint validation

#### Scenario: Failed replacement
- **WHEN** a synthetic replacement download is malformed, too large, canceled or returns expired authentication
- **THEN** the previous usable material survives, coverage records the actual failure and expired authentication uses `AUTH_EXPIRED`

### Requirement: Extract citable per-page text using unpdf
Extraction SHALL use pre-approved unpdf and preserve ordered one-based page numbers including empty pages. Every page SHALL pass deterministic redaction before normalized storage/model access and be represented as an existing `SourceItem` with `platform` Canvas/Ed and `kind: material`, stable provider/file/page identity, redacted text/hash and source provenance. Existing Citation fields SHALL resolve the trusted page text with a matching quote and `page N` locator; offsets/hashes remain private validation metadata. No new PDF/Citation entity/field or OCR dependency SHALL be introduced. Image-only/failed pages SHALL be explicit text-coverage gaps, never invented text or renumbered pages. Page replacement/deletion SHALL require completed validated extraction of the same material.

#### Scenario: Multi-page PDF with empty middle page
- **WHEN** a wholly synthetic three-page PDF has text on pages 1 and 3 only
- **THEN** extraction retains page numbers 1, 2 and 3, stores redacted page evidence and resolves page-3 quotes to page 3

#### Scenario: Wrong page citation
- **WHEN** a synthetic quote occurs on page 3 but its citation claims page 1
- **THEN** trusted page lookup rejects the mismatched locator without extending Citation fields

#### Scenario: Scanned or failed extraction
- **WHEN** a PDF is image-only or extraction fails before validating all pages
- **THEN** coverage reports unavailable/incomplete text, no text is invented and prior usable pages are not falsely deleted

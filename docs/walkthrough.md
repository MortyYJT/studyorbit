# Walk-through as a student

Written 2026-11-25. The whole product was walked the way a student would use it, from the first start to a normal day, and every place where the way forward was missing, wrong or too long was written down before any code was changed. This page lists what was found, what was changed and what was left.

## How it was done

- Two synthetic courses on a throw-away instance (ports 5181 and 5191, a temporary home folder), DeepTutor 1.7.4 on its test ports, the real `deepseek-flash` model for the assistant. No real course data, no real sync: "Sync now" and "Save selection" were never sent, the requests they make were answered inside the browser.
- A throw-away headless Chrome driven over the DevTools protocol with real mouse and key events, so a click that lands on an overlay is seen as such. Desktop 1440 × 900 and phone 390 × 844, light and dark, Chinese and English.
- The Desktop shortcut was read and its commands were run with the test ports. Closing its Terminal window was reproduced by sending a hang-up to the instance's own process group.
- "Clicks" counts presses of a button, row or link from the moment the student decides to do the thing. Typing and choosing a value in a field are not counted.

Not walked: a real sync and everything that only a real sync produces (sync conflicts, change reminders, failed or incomplete courses under "Needs you"); these were read in the code. Safari and Firefox. A person at a physical keyboard.

## What was changed

| Where | Before | After | Why | Clicks |
| --- | --- | --- | --- | --- |
| First open, no course list yet | The dialog said "No course list yet. Click 'Sync now'." The dialog is modal: on the desktop the click on the sidebar's button landed on the dialog and did nothing; on the phone the button was in the menu behind the dialog | The dialog has the "Sync now" button itself and says what it does: it reads your courses with the browser that is signed in to Canvas, then lets you choose | The only instruction on the page pointed at a control the page had just covered | Desktop 2 (one wasted before them) → 1. Phone 3 → 1 |
| Same dialog, nothing chosen yet | Titled "Edit courses" | "Choose courses" until a selection exists | There was nothing to edit | |
| Terminal, DeepTutor not installed or another provider chosen | Nothing about the assistant | One line: not installed (or DeepSeek only), the Agent page says what to do, the other pages work | The window is the first thing a new user reads | |
| Agent page, "DeepTutor is not installed" | Three lines to run. Pasted as a block on a machine without `uv`, the second line failed: the installer puts `uv` in `~/.local/bin` and leaves the running shell's `PATH` alone. No way to copy. "Then run `npm run dev` again", which someone who double-clicked a shortcut never typed | A fourth line puts `~/.local/bin` on the `PATH`; a "Copy these lines" button; the text says about 520 MB and names both ways to start again (close the Terminal window and open it again, or Ctrl+C and `npm run dev`). The other "not running" states use the same wording | The instructions failed for the reader they were written for | |
| "Needs you": overdue task, task that does not fit | The row opened the course page at its top. Nothing there is about the task; it is ticked, timed or removed in "Tasks and time", a folded list under the calendar on the page just left | The row opens that list and points at the task. Rows of personal tasks, which went nowhere, do the same | The row led away from the only place that clears it | Clearing an overdue task: 4 → 2 |
| "Tasks and time" | A task could be ticked, timed or removed, not re-planned | A task that belongs to an assessment has "Re-plan", which opens that assessment's drawer | Changing the estimate is the other way to clear "does not fit" | To the estimate field from "Needs you": 3 or more → 2 |
| "Needs you": due within seven days and not planned; a deadline chip or a plan block in the week or month | The course page at its top. The plan form is in the assessment's drawer, and the assessment may sit inside a folded parent | Arrives with that assessment's drawer open, with the same neighbours a click on its row gives | The student had to find the row again | To the plan form: 2 or 3 → 1 |
| Course page, link back | "← Plan"; the changes card said "on the plan page" | "← This week", the name the sidebar and the page heading use | Two names for one page | |
| Assessment drawer → Edit → Due | Free text. "12月10日" was saved and shown as the due value; the assessment lost its day on the calendar | A day (`2026-12-10`, `2026/12/10`, `2026-3-5`) or a date-time with a zone is accepted; anything else is refused with a sentence saying what to write | A wrong value was stored without a word | |
| Edit and "Add assessment" forms | A score above the maximum, or a number out of range: Save did nothing | "Not saved:" and the reason, under the button | A button that seemed dead | |
| Edit forms | A save changed the values on the page and said nothing | "Saved." under the button | No feedback | |
| Edit forms → Status | A text box holding `not_started`. Only `submitted` and `graded` count a deadline as done; "已提交" typed there was stored and counted for nothing | A select: Not set, Not started, In progress, Submitted, Graded. A stored value that is none of these stays as one more choice | An internal code that the user had to guess | |
| Assessment drawer | Esc did nothing | Esc closes it, as it closes the dialogs | | |
| "Add assessment" → Type | "Quiz", "Test" in the Chinese interface, "Test" in the English one; elsewhere 测验, 考试 and "Exam" | The same names as everywhere else | Copy out of step | |
| Daily hours at 390 | The seven fields left the card: the document was 436 px wide in a 390 px window. On the desktop the fields touched | The fields fit, with gaps | Other forms give each field 150 px; seven of them do not fit | |
| Month view | The range read "2026-11" | "2026年11月" / "November 2026" | A raw value where the week view writes dates in words | |
| Revision presets | One click sent a prompt that cost 44,167 tokens in this walk. The warning was a hover title, which a phone never shows | One line under the buttons says that a click sends the prompt and uses tens of thousands of tokens | Credit was spent without a visible word | |
| Revision notes | "Keep new notes in DeepTutor's own Notebook (left side of the Agent page)" | Says that new notes cannot be saved for now and where the conversations are | Not true in this installation: "Notebook" in DeepTutor's sidebar opens a module that is not installed, "Create note" on a chat answers "Error: Not Found", and replies have no save action | |
| Agent page, language | DeepTutor's page and its replies were English beside a Chinese StudyOrbit | Before the frame is created, DeepTutor is told the page's language (`PUT /api/local/deeptutor/language`, which sets `language` and `response_language` through DeepTutor's settings API). Measured: a new browser on a Chinese page got a Chinese DeepTutor, on an English page an English one | Two languages on one page, and Chinese questions answered in English | |
| Agent page, bar | "DeepTutor", or "Opened from SYNT10001" | Adds: it reads the courses, marks, deadlines and tasks in StudyOrbit, not the corrections made on a course page | A new user could not tell where the numbers come from, or why they differ from the course page after a correction | |
| Agent page at 390 | Top bar "Agent", heading "Agent", then the bar and the frame: 654 of 844 px for the frame | The heading is kept for screen readers only, and the bar is one paragraph with the "Open in a new tab" link at its end: 693 px for the frame in Chinese, 675 px in English, with the longer bar | The heading repeated the top bar | |
| Owner menu | "Sync data", under a button called "Sync now" | "Sync records" | It read like an action; it opens the records of past syncs | |
| Settings → Analysis model | "The model that organises course data during a sync" | Also says that the assistant uses the same provider and key and works with DeepSeek only; after a change of provider the "Saved" line says the assistant follows once StudyOrbit is started again | Switching provider there switches the Agent page off | |
| Avatar without a photo | The letter "Y" | The product mark | An initial that belongs to one person, in a public repository | |
| Fields at 390 | 28 to 32 px tall with 13 px text, on every page | Fields are 44 px tall with 16 px text; so are the two buttons at the foot of the phone menu and a form's own button | Touch targets, and iOS Safari zooms the page when a field with text under 16 px takes focus (the zoom itself was not checked in Safari) | |

The language is a default, not a switch: DeepTutor keeps its language in the browser once its page has been opened there, and that stored value wins. Measured: with DeepTutor's server setting changed to English, a browser that had already opened it in Chinese stayed Chinese. After the first visit the language is changed in DeepTutor's own settings. DeepTutor's theme cannot be set this way at all (it ignored the server setting in both directions) and still follows the system.

## Looked at and found in order

| Worry | What was seen |
| --- | --- |
| Enter does not send in the framed chat | It sends. Chinese text entered as a text-input event and then Enter with real key-down and key-up events sent the message; so did a follow-up typed key by key |
| "Solve" and "Research" under DeepTutor's composer lead to modules that are not installed | They are groups of four prompt starters for the normal chat (for Solve: "walk me through one step at a time … do not give the final answer"). Nothing is missing behind them |
| Closing the shortcut's Terminal window leaves DeepTutor running | A hang-up to the instance's process group stopped all five processes and closed all five ports within 4 s. `server.lock` and DeepTutor's process record stayed behind; the next start came up normally |
| The assistant's numbers | 74.8% on 45% graded and 84.25% needed for an H1: equal to the course page (which rounds to 84.3%) |
| Target grade | One choice; the needed average changes at once (84.3%, 57.0%, 29.7% for H1, H3, P on the synthetic course) |
| Daily hours, add task, month navigation, marking a task done | Work as expected; adding a task is a title and Enter |
| A question from a course on the phone | Answered for that course without naming it; no horizontal overflow at 390 in the page or the frame |
| DeepTutor stopped while its page is open | Within 5 s the frame is replaced by the reason and what to do; the other pages keep working |

## Left for later

| Finding | Why it was left |
| --- | --- |
| Coming back to the Agent page starts a new empty chat. The frame is created each time the page is shown (about 5 s), the conversation has to be picked from DeepTutor's list (2 clicks on the desktop, 4 on the phone), and every load makes DeepTutor ask the model for suggestions: 24 such calls, 23,342 tokens, in this walk | The frame lives only while the page shows by an earlier decision, made so that DeepTutor is not loaded in the background. Keeping it alive after the first visit would fix all three; what a hidden DeepTutor page does to the model has to be measured first |
| New revision notes cannot be saved | "Save to revision" went with the built-in chat. Bringing it back (a small form on the revision tab) is a feature |
| The sync records dialog grows when its rows arrive after it has opened (126 → 709 px with a 1.5 s delay; phone 120 → 812) | Confirmed. The read starts when the owner menu opens, so it needs an API slower than two clicks; the number of rows is not known beforehand |
| The month view at 390: 51 px cells, a deadline label breaks into three to five lines inside a course code | Needs another presentation on a phone (marks in the cells, a list under them) |
| Buttons at 390 are 32 px tall, small ones 28 px | Fields and the menu were raised to 44 px; raising every button changes the toolbars of every page. WCAG 2.2 AA asks for 24 px |
| The weight bar reads "105/100" after an added item, without a remark | The student's own entry; a rule is needed for what counts (bonus items already do not) |
| Saving the edit form writes every field as a correction, the untouched ones too | May show as conflicts after a later sync; needs a design and a real sync to try |
| The due field of the edit form shows a synced date-time as `2026-11-27T12:59:00Z` | It is kept as text so that saving the form does not drop the time; a date-and-time field needs the time zone handled |
| A reply once volunteered that "this DeepTutor instance has no embedding model … I can set it up for you" | Seen in one reply of six; a rule in the house rules would need trials to show that it works |
| The weekly-plan reply quoted the snapshot's save time in UTC ("02:47") | The tool returns an ISO instant; a local time would need the zone passed through |
| DeepTutor's own page: `GET /api/tools` answers 500 (`No module named 'deeptutor.capabilities.notes'`), "Notebook" and "Create note" are dead ends, several 404s for modules that are not installed | DeepTutor's own interface and packaging; not patched here, not reported upstream yet |
| DeepTutor's theme follows the system, not the theme picked in StudyOrbit | Its page ignores the server-side setting |
| The Desktop shortcut on a machine without Node 24 ends with "command not found" and "stopped (exit 127)" | The shortcut is a file on the owner's Desktop, outside the repository |

## Model use

Six questions typed into the framed page, DeepTutor's own usage ledger:

| # | Asked | From | Calls | Tokens |
| --- | --- | --- | --- | --- |
| 1 | Current average and what is needed for an H1 (Chinese, Enter) | "Ask Agent" on SYNT10001 | 7 | 78,219 |
| 2 | Follow-up typed key by key: what if Assignment 2 gets 80% | same conversation | 3 | 48,862 |
| 3 | What to do first this week, from my StudyOrbit tasks | a new conversation in DeepTutor's list | 5 | 45,906 |
| 4 | Revision preset "Revise with the agent" | revision tab of SYNT20002 | 5 | 44,167 |
| 5 | Next deadline of this course and its weight | phone 390, "Ask Agent" on SYNT20002 | 4 | 31,752 |
| 6 | Current average and the H1 target (English page, after the changes; the README picture) | "Ask Agent" on SYNT10001 | 4 | 35,193 |
| | Input suggestions and titles, asked by DeepTutor each time its page loads | | 24 | 23,342 |

Total: 52 calls, 307,441 tokens (237,952 of the input were cache hits).

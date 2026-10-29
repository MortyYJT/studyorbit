## ADDED Requirements

### Requirement: Daily availability
The owner SHALL be able to set available study minutes for each weekday (Monday to Sunday, 0–1440 each, default 120), stored in browser storage. Invalid stored values fall back to the default.

#### Scenario: Weekend off
- **WHEN** the owner sets Saturday and Sunday to 0
- **THEN** the scheduler places nothing on weekends

### Requirement: Manual tasks
"Add task" SHALL create a task with a title, a deadline date, an estimate in minutes and an optional course; a task without a course is shown as an external task.

#### Scenario: External task
- **WHEN** the owner adds "Internship application" due 2026-11-05 with 90 minutes and no course
- **THEN** the task is saved and scheduled like coursework tasks

### Requirement: Deterministic earliest-deadline-first schedule
The system SHALL schedule unfinished tasks from today forward: tasks in order of deadline (ties by key), each filling the earliest days with remaining capacity up to and including its deadline, split across days when needed. Remaining minutes are the estimate minus minutes spent, never below zero. The same inputs SHALL always give the same schedule.

#### Scenario: Earlier deadline goes first
- **WHEN** task A (60 min, due in 3 days) and task B (60 min, due tomorrow) compete for a day with 60 free minutes today
- **THEN** B is placed today and A after it

#### Scenario: Task split across days
- **WHEN** a 150-minute task is due in 2 days and each day has 60 minutes
- **THEN** it is placed as 60, 60 and 30 minutes on today, tomorrow and the deadline day

#### Scenario: Spent time reduces the plan
- **WHEN** a 120-minute task has 90 minutes spent
- **THEN** only 30 minutes are scheduled

### Requirement: Overflow is listed, never dropped
Minutes that cannot be placed by a task's deadline, and every unfinished task whose deadline has passed, SHALL be returned as overflow with the unplaced minutes and shown to the owner.

#### Scenario: Not enough time
- **WHEN** a 200-minute task is due today and today has 120 minutes
- **THEN** 120 minutes are placed today and 80 minutes are listed as overflow

#### Scenario: Overdue task
- **WHEN** an unfinished task's deadline was yesterday
- **THEN** nothing is placed for it and it is listed as overdue

### Requirement: Deadlines on the week and month views
The week and month views SHALL show, on each day, the deadlines of visible synced assessments of the selected courses (using the owner's corrected dates) and of tasks, each once.

#### Scenario: Unplanned assessment deadline
- **WHEN** a synced assessment is due on Thursday and has no task
- **THEN** Thursday shows its deadline in the week view

### Requirement: Actual time and done state
Each task SHALL record minutes spent and whether it is done. A done task is not scheduled and shows its estimate against the actual minutes.

#### Scenario: Finishing a task
- **WHEN** the owner marks a 60-minute task done with 90 minutes spent
- **THEN** it leaves the schedule and shows estimate 60 against actual 90

### Requirement: Needs-you strip
The week view SHALL show, above the calendar, the overflow and overdue tasks, courses whose latest sync failed, and graded assessments due within the next seven days that have no task and are not submitted or graded. The strip is hidden when empty.

#### Scenario: Deadline soon without a plan
- **WHEN** a weighted quiz is due in three days, is not submitted and has no task
- **THEN** the strip lists it with its course and date

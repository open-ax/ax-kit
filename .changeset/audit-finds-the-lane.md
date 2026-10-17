---
"@ax-kit/cli": patch
---

The audit now says which of its checks an agent can act on

Every finding now carries one of two labels. `enforced` means a failure there
stops an agent using the page as it declared it would; `advisory` means the
check is about quality and blocks nothing anywhere. The report prints the split
on every run, along with a statement of what the two words mean, and each line
is tagged.

The exit code is unchanged and still counts every finding, so a non-zero exit is
not a verdict on what an agent can invoke. The output says so on every run.

The readiness rule also changed. The audit used to drain a fixed number of task
turns after the page's context appeared, which measured the machine rather than
the page: a page that fetches its tool definitions registered nothing while the
fetch was outstanding, so how many turns it needed said as much about response
delivery as about the page. On a fixture declaring one tool per round trip, four
turns reported five of the eight tools, sixty-four reported seven, and a
windowed stability check reported six. The tool list tracked the wait, not the
page, and on a slow machine the audit reported a wrong answer rather than a slow
one. It now waits for the browser to report that the page has stopped fetching.
Both waits remain bounded and neither bound decides anything except how long the
audit is willing to look.
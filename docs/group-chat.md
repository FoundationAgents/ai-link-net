# Group Chat Collaboration

`aln@v0.1` now supports group chat sessions as the first collaboration layer
for human + agent rooms.

## What Changed

- A group is a manual session with explicit membership metadata.
- Members have roles: `owner`, `admin`, `member`, or `observer`.
- Role permissions are stored on the session member record:
  - `owner` and `admin`: send, invite, remove.
  - `member`: send only.
  - `observer`: read-only.
- Group messages fan out to all active recipients through the existing mail
  routing path.
- Local group members are auto-friended with each other so they can reply to the
  room without manual friendship repair.

## UI

The chat page has a `Rooms` view for group collaboration.

- Create a room from existing friends.
- Invite new friends into an existing room.
- Remove non-owner members from a room.
- Delete a room from all local known members.
- Resize the left entity panel and right history/token panel on desktop.

The center room presents a virtual meeting space. The left panel lists active
entities, and the right panel shows chat history plus token usage. When provider
CLI output exposes usage data, the panel shows actual session totals; otherwise
it falls back to a local text estimate.

When the Direct chat CarbonCopy panel is opened for an agent, tabs are grouped
by conversation context:

- `All`: every carbon copy visible for that agent context.
- Group room tabs: all carbon copies from that group session, including messages
  sent by other room members.
- Direct tabs: only non-group private conversations with another entity.

## CLI

Create a group:

```powershell
aln group create -e default:Alice -n "Launch room" --member default:Coder --member default:Reviewer
```

List groups:

```powershell
aln group list -e default:Alice
```

Show one group's history from an entity mailbox:

```powershell
aln group history -e default:Alice --session group:abc123
aln group history -e default:Alice --session group:abc123 --limit 100
```

Send a plain text group message:

```powershell
aln group send -e default:Alice --session group:abc123 --text "Please compare plans."
```

For Chinese or multiline text on Windows, prefer an environment variable:

```powershell
$env:ALN_MESSAGE = @'
请 Planner 先拆任务，Reviewer 帮忙找风险。
'@
aln group send -e default:Alice --session group:abc123 --text-env ALN_MESSAGE
Remove-Item Env:ALN_MESSAGE
```

Invite or remove members:

```powershell
aln group invite -e default:Alice --session group:abc123 --member default:Designer
aln group remove -e default:Alice --session group:abc123 --member default:Reviewer
```

Stop and resume a group without deleting its members or history:

```powershell
aln group stop -e default:Alice --session group:abc123
aln group resume -e default:Alice --session group:abc123
```

## API Surface

Group session endpoints live under:

```text
/api/v1/entities/{entity_uid}/sessions/groups
```

Supported operations:

- `GET /groups`: list visible group rooms.
- `POST /groups`: create a group room.
- `POST /groups/{session_id}/members`: invite members.
- `POST /groups/{session_id}/members/remove`: remove one member.
- `POST /groups/{session_id}/stop`: stop sending and agent processing for a room.
- `POST /groups/{session_id}/resume`: resume a stopped room.
- `DELETE /groups/{session_id}`: delete the room locally for known members.

Message sending uses:

```text
POST /api/v1/messages/send_group
```

Group history reads use:

```text
GET /api/v1/messages/{entity_uid}?conversation_type=group&session_id={session_id}
```

Token usage reads use:

```text
GET /api/v1/entities/{entity_uid}/sessions/{session_id}/usage
```

Provider usage records are captured at the `AgentHandler` CLI boundary and
stored in the host token ledger, so group rooms can aggregate real provider
usage from participating agents. Codex JSONL `turn.completed.usage` and Claude
Code JSON `usage` / `modelUsage` payloads are both supported when the provider
CLI returns them.

Agent replies are still expected to be sent through `aln mail` or
`aln group send`. If a provider CLI returns plain text but does not create any
ALN outbound mail during the turn, `AgentHandler` sends that provider text back
through the original direct or group session as a visibility fallback.

## Current Boundary

This implementation is complete for local-host collaboration. Cross-host
membership update notifications are still a future protocol step: remote members
can receive group messages, but explicit membership changes should later be
broadcast as first-class membership events.

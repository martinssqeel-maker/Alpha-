import { useApp } from '../../store/useApp'
import ActivityTimeline from '../ActivityTimeline'
import DvrScrubber from '../DvrScrubber'

export default function ActivityPanel() {
  const streaming = useApp((s) => s.streaming)
  const messages = useApp((s) => s.messages)

  const streamingActivities = streaming?.activities ?? []
  const lastWithActivity = [...messages].reverse().find((m) => m.activity && m.activity.length > 0)
  const activities = streamingActivities.length ? streamingActivities : lastWithActivity?.activity ?? []

  // The scrubber refreshes when the activity list changes, so a finished step
  // appears in the replay without polling.
  const revision = activities.length + (streamingActivities.length ? 1 : 0)

  if (activities.length === 0) {
    return (
      <div className="p-3 overflow-auto h-full flex flex-col gap-3">
        <Empty text="No tool activity yet. Activity appears here when the assistant reads files, runs commands, or proposes edits." />
        <DvrScrubber revision={revision} />
      </div>
    )
  }

  return (
    <div className="p-3 overflow-auto h-full flex flex-col gap-3">
      <div className="text-xs" style={{ color: 'var(--muted)' }}>
        {activities.length} action{activities.length === 1 ? '' : 's'}
      </div>
      <ActivityTimeline activities={activities} />
      <DvrScrubber revision={revision} />
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-full p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
      {text}
    </div>
  )
}

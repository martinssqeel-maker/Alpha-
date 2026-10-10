import { useApp } from '../store/useApp'

export default function ApprovalDialog() {
  const approval = useApp((s) => s.pendingApprovals[0])
  const respond = useApp((s) => s.respondApproval)
  if (!approval) return null
  return (
    <div className="modal-backdrop">
      <div className="card" style={{ width: 460, maxWidth: '90vw' }}>
        <h3 className="text-base font-semibold mb-1">Approval required</h3>
        <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
          The assistant wants to perform an action. This approval applies only to this action.
        </p>
        <div className="card tight mb-4" style={{ background: 'var(--surface-2)' }}>
          <div className="font-medium mb-1 mono text-sm">{approval.title}</div>
          {approval.detail && (
            <pre className="mono text-xs whitespace-pre-wrap" style={{ color: 'var(--text-soft)', margin: 0 }}>
              {approval.detail}
            </pre>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={() => respond(approval.approvalId, false)}>
            Deny
          </button>
          <button className="btn primary" onClick={() => respond(approval.approvalId, true)}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

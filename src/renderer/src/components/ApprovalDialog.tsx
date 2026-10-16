import { useApp } from '../store/useApp'

export default function ApprovalDialog() {
  const approval = useApp((s) => s.pendingApprovals[0])
  const respond = useApp((s) => s.respondApproval)
  if (!approval) return null
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="card approval-dialog" style={{ width: 480, maxWidth: '90vw' }} role="alertdialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-description">
        <h3 className="text-base font-semibold mb-1">Approval required</h3>
        <p id="approval-description" className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
          Review the action, target, and consequence. This approval applies only to this request.
        </p>
        <div className="card tight mb-4" style={{ background: 'var(--surface-2)' }}>
          <div id="approval-title" className="font-medium mb-1 text-sm">{approval.title}</div>
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

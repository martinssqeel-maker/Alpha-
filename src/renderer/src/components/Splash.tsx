export default function Splash({ leaving }: { leaving: boolean }) {
  return (
    <div className={`splash${leaving ? ' splash-leaving' : ''}`}>
      <div className="splash-inner">
        <div className="splash-logo">
          <div className="splash-ring" />
          <div className="splash-mark">A</div>
        </div>
        <div className="splash-title">Alpha AI Workspace</div>
        <div className="splash-sub">Your local AI development environment</div>
        <div className="splash-bar">
          <span />
        </div>
      </div>
    </div>
  )
}
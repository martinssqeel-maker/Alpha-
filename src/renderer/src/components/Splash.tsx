import alphaLogo from '../assets/alpha-logo.png'

export default function Splash({ leaving }: { leaving: boolean }) {
  return (
    <div className={`splash${leaving ? ' splash-leaving' : ''}`}>
      <div className="splash-inner">
        <div className="splash-logo">
          <div className="splash-ring" />
          <img className="splash-mark" src={alphaLogo} alt="" draggable={false} />
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
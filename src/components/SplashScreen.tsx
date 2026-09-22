// First-open brand splash: big Bharat Market Pro wordmark + the dollar-bill mark, which then
// shrinks and flies up to the top-left as the overlay dissolves — handing off to the
// real header logo underneath for a seamless transition into the app.
// Plays once per browser session (sessionStorage); click anywhere to skip.
import { useEffect, useState } from 'react'

type Phase = 'in' | 'hold' | 'out' | 'done'

export function SplashScreen() {
  const [phase, setPhase] = useState<Phase>(() => (sessionStorage.getItem('bmp_splash_seen') ? 'done' : 'in'))

  useEffect(() => {
    if (phase === 'done') return
    sessionStorage.setItem('bmp_splash_seen', '1')
    const t1 = setTimeout(() => setPhase('hold'), 60) // trigger the enter transition
    const t2 = setTimeout(() => setPhase('out'), 1750) // begin the fly-to-corner exit
    const t3 = setTimeout(() => setPhase('done'), 2700) // unmount
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (phase === 'done') return null
  const entered = phase !== 'in'
  const out = phase === 'out'

  return (
    <div
      onClick={() => setPhase('out')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 38%, #ffffff 0%, #eef1f4 55%, #e6eaee 100%)',
        opacity: out ? 0 : 1,
        transition: 'opacity .85s ease',
        pointerEvents: out ? 'none' : 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 24,
          transformOrigin: 'center center',
          // Exit: shrink + travel toward the header's top-left logo slot.
          transform: out
            ? 'translate(calc(-50vw + 64px), calc(-50vh + 46px)) scale(0.22)'
            : entered
              ? 'translate(0,0) scale(1)'
              : 'translate(0,0) scale(0.82)',
          opacity: entered ? 1 : 0,
          transition: out
            ? 'transform .95s cubic-bezier(.66,0,.2,1), opacity .6s ease .4s'
            : 'transform .85s cubic-bezier(.2,.7,.2,1), opacity .7s ease',
        }}
      >
        <img
          src="/rupee-logo.png"
          alt="Bharat Market Pro"
          style={{ height: 148, width: 'auto', objectFit: 'contain', filter: 'drop-shadow(0 18px 42px rgba(184,140,24,.38))' }}
        />
        <div style={{ textAlign: 'center', opacity: out ? 0 : 1, transition: 'opacity .35s ease' }}>
          <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: '#16181d' }}>
            Bharat <span style={{ color: '#1d9d6f' }}>Market Pro</span>
          </div>
          <div style={{ marginTop: 13, fontSize: 13.5, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#9aa1ab' }}>
            see beyond the ticker
          </div>
        </div>
      </div>
    </div>
  )
}

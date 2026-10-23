import { BadgeCheck, KeyRound, Rocket, Radar, AlertTriangle, XCircle, WifiOff, MessageCircle, Repeat2, Heart } from 'lucide-react'
import { shortAgo } from './ui.jsx'

const KIND = {
  auth: { icon: KeyRound, cls: 'bg-ok/10 text-ok' },
  deploy: { icon: Rocket, cls: 'bg-accent/10 text-accent' },
  scan: { icon: Radar, cls: 'bg-accent/10 text-accent' },
  warn: { icon: AlertTriangle, cls: 'bg-amber-100 text-amber-600' },
  fail: { icon: XCircle, cls: 'bg-bad/10 text-bad' },
  offline: { icon: WifiOff, cls: 'bg-line text-muted' },
}

function Body({ event }) {
  if (event.kind === 'fail' || event.kind === 'warn') return <p className="text-bad">&gt;{event.text}</p>
  return (
    <>
      <p className="greentext">&gt;{event.text}</p>
      {event.kind === 'offline' && <p className="text-bad font-bold text-[12px] mt-1">(NODE WAS MARKED OFFLINE FOR THIS POST)</p>}
    </>
  )
}

export default function ActivityFeed({ events, limit }) {
  const list = limit ? events.slice(0, limit) : events

  return (
    <section className="card overflow-hidden self-start">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="font-bold text-[17px]">Activity</h2>
        <span className="flex items-center gap-1.5 text-[13px] text-muted">
          <span className="size-2 rounded-full bg-ok animate-pulse" /> Live
        </span>
      </div>
      {list.length === 0 && <p className="px-4 py-6 text-center text-muted text-[14px]">No activity yet.</p>}
      <ol>
        {list.map((e, i) => {
          const { icon: Icon, cls } = KIND[e.kind]
          // fake engagement numbers, stable per event
          const replies = e.no % 4
          const reposts = (e.no >> 2) % 6
          const likes = (e.no >> 1) % 23
          return (
            <li key={e.no} className="flex gap-3 px-4 py-3 border-t border-line hover:bg-soft transition-colors">
              <div className={`size-9 shrink-0 rounded-full grid place-items-center ${cls}`}>
                <Icon className="size-4" />
              </div>
              <article className="min-w-0 flex-1 text-[14px]">
                <header className="flex items-center gap-1 text-[14px] min-w-0">
                  <strong className="truncate">m12d</strong>
                  <BadgeCheck className="size-4 shrink-0 text-accent" />
                  <span className="text-muted truncate">@m12d · {shortAgo(e.at)}</span>
                  <span className="ml-auto text-muted text-[11px] shrink-0">No.{e.no}</span>
                </header>
                <div className="mt-0.5 break-words leading-snug">
                  <Body event={e} />
                </div>
                <div className="flex gap-6 mt-2 text-muted text-[12px]">
                  <span className="flex items-center gap-1 hover:text-accent cursor-pointer">
                    <MessageCircle className="size-3.5" /> {replies || ''}
                  </span>
                  <span className="flex items-center gap-1 hover:text-ok cursor-pointer">
                    <Repeat2 className="size-3.5" /> {reposts || ''}
                  </span>
                  <span className="flex items-center gap-1 hover:text-pink-600 cursor-pointer">
                    <Heart className="size-3.5" /> {i < 3 ? likes : ''}
                  </span>
                </div>
              </article>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

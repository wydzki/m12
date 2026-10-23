import { useState } from 'react'

const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="block font-mono text-[12px] text-muted uppercase tracking-wider mb-1">{label}</span>
    {children}
    {hint && <span className="block text-muted text-[11px] font-mono mt-1">{hint}</span>}
  </label>
)

export default function SettingsPanel({ subnet }) {
  const [saved, setSaved] = useState(false)

  function save(e) {
    e.preventDefault()
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <section className="card p-4 max-w-xl">
      <h2 className="font-mono font-semibold text-[13px] text-bright uppercase tracking-wider mb-4">Configuration</h2>
      <form onSubmit={save} onChange={() => setSaved(false)} className="space-y-4">
        <Field label="subnet">
          <input className="field" defaultValue={subnet} />
        </Field>
        <Field label="poll interval">
          <select className="field" defaultValue="60">
            <option value="30">30s</option>
            <option value="60">60s</option>
            <option value="300">300s</option>
          </select>
        </Field>
        <Field label="offline threshold" hint="missed check-ins before a node is marked offline">
          <input type="number" className="field max-w-32" defaultValue={10} />
        </Field>
        <Field label="webhook">
          <input className="field" placeholder="https://hooks.example.com/m12" />
        </Field>
        <div className="flex flex-col gap-2 text-[13px] font-mono">
          <label className="flex items-center gap-2 text-ink cursor-pointer">
            <input type="checkbox" className="accent-accent size-3.5" defaultChecked /> auto-deploy to new nodes
          </label>
          <label className="flex items-center gap-2 text-ink cursor-pointer">
            <input type="checkbox" className="accent-accent size-3.5" /> hide offline nodes
          </label>
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button type="submit" className="btn btn-primary">
            save
          </button>
          {saved && <span className="text-ok text-[12px] font-mono">saved.</span>}
        </div>
      </form>
    </section>
  )
}

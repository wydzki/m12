import { useState } from 'react'

const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="block font-semibold text-[14px] mb-1">{label}</span>
    {children}
    {hint && <span className="block text-muted text-[13px] mt-1">{hint}</span>}
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
    <section className="card p-5 max-w-xl">
      <h2 className="font-bold text-[20px] mb-5">Settings</h2>
      <form onSubmit={save} onChange={() => setSaved(false)} className="space-y-4">
        <Field label="Subnet">
          <input className="field font-mono" defaultValue={subnet} />
        </Field>
        <Field label="Scan interval">
          <select className="field" defaultValue="60">
            <option value="30">Every 30 seconds</option>
            <option value="60">Every minute</option>
            <option value="300">Every 5 minutes</option>
          </select>
        </Field>
        <Field label="Offline after" hint="Missed check-ins before a node is marked offline.">
          <input type="number" className="field max-w-32" defaultValue={10} />
        </Field>
        <Field label="Alert webhook">
          <input className="field" placeholder="https://hooks.example.com/m12" />
        </Field>
        <div className="flex flex-col gap-2 text-[14px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-accent size-4" defaultChecked /> Auto-deploy agent to new nodes
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-accent size-4" /> Hide offline nodes from the overview
          </label>
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button type="submit" className="pill pill-dark">
            Save
          </button>
          {saved && <span className="greentext text-[14px]">&gt;Settings saved.</span>}
        </div>
      </form>
    </section>
  )
}

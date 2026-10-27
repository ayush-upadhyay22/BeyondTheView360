import { useId } from 'react';
import {
  TOUR_VISIBILITIES,
  httpUrlSchema,
  type HotspotDTO,
  type SceneDTO,
  type TourDTO,
  type TourVisibility,
  type UpdateHotspotInput,
  type UpdateTourInput,
} from '@btv/shared';
import { CloseIcon, CrosshairIcon, TrashIcon } from '../components/icons';
import { AutoField } from './AutoField';

const VISIBILITY_HELP: Record<TourVisibility, string> = {
  private: 'Only you can view it.',
  unlisted: 'Anyone with the link can view it.',
  public: 'Anyone can view it; it may be shared and indexed.',
};

export function HotspotPanel({
  hotspot,
  scenes,
  onChange,
  onDelete,
  onClose,
  onLookAt,
}: {
  hotspot: HotspotDTO;
  /** Ready scenes of the tour (link targets). */
  scenes: SceneDTO[];
  onChange: (input: UpdateHotspotInput) => void;
  onDelete: () => void;
  onClose: () => void;
  onLookAt: () => void;
}) {
  const targetId = useId();
  const targets = scenes.filter((s) => s.id !== hotspot.sceneId);

  return (
    <section aria-labelledby="hotspot-heading" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 id="hotspot-heading" className="font-semibold">
          {hotspot.type === 'link' ? 'Link hotspot' : 'Info hotspot'}
        </h2>
        <button
          type="button"
          className="rounded p-1 text-slate-400 hover:text-white"
          onClick={onClose}
          aria-label="Close hotspot editor"
        >
          <CloseIcon size={18} />
        </button>
      </div>

      {hotspot.type === 'link' ? (
        <>
          <div>
            <label className="label" htmlFor={targetId}>
              Goes to
            </label>
            <select
              id={targetId}
              className="input"
              value={hotspot.targetSceneId ?? ''}
              onChange={(e) => onChange({ targetSceneId: e.target.value })}
            >
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <AutoField
            key={`${hotspot.id}-title`}
            label="Label (optional)"
            value={hotspot.title}
            maxLength={120}
            placeholder="Defaults to the scene name"
            onSave={(title) => onChange({ title })}
          />
        </>
      ) : (
        <>
          <AutoField
            key={`${hotspot.id}-title`}
            label="Title"
            value={hotspot.title}
            maxLength={120}
            validate={(v) => (v.trim() ? null : 'A title is required')}
            onSave={(title) => onChange({ title })}
          />
          <AutoField
            key={`${hotspot.id}-text`}
            label="Text"
            value={hotspot.text}
            maxLength={2000}
            multiline
            onSave={(text) => onChange({ text })}
          />
          <AutoField
            key={`${hotspot.id}-image`}
            label="Image URL (optional)"
            value={hotspot.imageUrl ?? ''}
            placeholder="https://…"
            validate={(v) =>
              !v.trim() || httpUrlSchema.safeParse(v).success ? null : 'Enter an http(s) URL'
            }
            onSave={(url) => onChange({ imageUrl: url || null })}
          />
        </>
      )}

      <p className="text-xs text-slate-500">
        Drag the marker in the viewer to move it. Position: {hotspot.yaw.toFixed(1)}°,{' '}
        {hotspot.pitch.toFixed(1)}°
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1" onClick={onLookAt}>
          <CrosshairIcon size={16} /> Look at
        </button>
        <button type="button" className="btn-danger" onClick={onDelete}>
          <TrashIcon size={16} /> Delete
        </button>
      </div>
    </section>
  );
}

export function TourSettings({
  tour,
  readyScenes,
  onChange,
}: {
  tour: TourDTO;
  readyScenes: SceneDTO[];
  onChange: (input: UpdateTourInput) => void;
}) {
  const startId = useId();
  return (
    <section aria-labelledby="tour-settings" className="space-y-4">
      <h2 id="tour-settings" className="font-semibold">
        Tour settings
      </h2>
      <AutoField
        key={`${tour.id}-title`}
        label="Title"
        value={tour.title}
        maxLength={120}
        validate={(v) => (v.trim() ? null : 'A title is required')}
        onSave={(title) => onChange({ title })}
      />
      <AutoField
        key={`${tour.id}-description`}
        label="Description"
        value={tour.description}
        maxLength={2000}
        multiline
        onSave={(description) => onChange({ description })}
      />
      <fieldset>
        <legend className="label">Visibility</legend>
        <div className="space-y-1.5">
          {TOUR_VISIBILITIES.map((v) => (
            <label
              key={v}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                tour.visibility === v ? 'border-brand-400/70 bg-brand-500/10' : 'border-ink-700'
              }`}
            >
              <input
                type="radio"
                name="visibility"
                value={v}
                checked={tour.visibility === v}
                onChange={() => onChange({ visibility: v })}
                className="mt-0.5 accent-brand-500"
              />
              <span>
                <span className="font-medium capitalize">{v}</span>
                <span className="block text-xs text-slate-400">{VISIBILITY_HELP[v]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor={startId}>
          Start scene
        </label>
        <select
          id={startId}
          className="input"
          value={tour.startSceneId ?? ''}
          onChange={(e) => onChange({ startSceneId: e.target.value || null, startView: null })}
          disabled={readyScenes.length === 0}
        >
          <option value="">First scene</option>
          {readyScenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">
          {tour.startView
            ? `Opens facing ${tour.startView.yaw.toFixed(0)}°. `
            : 'Opens at the scene’s own start view. '}
          Use “Tour starts here” in the viewer toolbar to set the exact view.
        </p>
      </div>
    </section>
  );
}

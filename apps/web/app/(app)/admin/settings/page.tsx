'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';

type Settings = {
  'auth.sessionIdleTimeoutMinutes': number;
  'auth.maxFailedLogins': number;
  'auth.passwordMinLength': number;
  'members.selfEditableFields': string[];
  'files.maxUploadBytes': number;
  'certificates.expiringSoonDays': number;
  'purchasing.allowOverAllocation': boolean;
};

const SELF_FIELDS: [string, string][] = [
  ['email', 'E-mail personnel'],
  ['phone', 'Téléphone'],
  ['address', 'Adresse'],
  ['emergencyContactName', "Contact d'urgence (nom)"],
  ['emergencyContactPhone', "Contact d'urgence (téléphone)"],
];

const MB = 1024 * 1024;

/**
 * Champ numérique + bouton d'enregistrement. Déclaré hors de `SettingsPage` : un composant défini
 * dans le rendu change d'identité à chaque frappe et l'<Input> perdrait le focus (ADM-08).
 */
function NumberSetting({
  id,
  label,
  hint,
  min,
  max,
  unit,
  value,
  dirty,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  unit?: string;
  value: number;
  dirty: boolean;
  onChange: (v: number) => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-line py-3 last:border-0">
      <Field label={label} hint={hint} className="min-w-[260px] flex-1" htmlFor={`s-${id}`}>
        <div className="flex items-center gap-2">
          <Input id={`s-${id}`} type="number" min={min} max={max} className="w-32" value={value} onChange={(e) => onChange(Number(e.target.value))} />
          {unit && <span className="text-sm text-ink-muted">{unit}</span>}
        </div>
      </Field>
      <Button variant="secondary" size="sm" onClick={onSave} disabled={!dirty}>Enregistrer</Button>
    </div>
  );
}

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

/** Paramètres laissés configurables au Super Admin (CDC §17.1). */
export default function SettingsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings'), enabled: can('settings.manage') });
  // Limite serveur (UPLOAD_MAX_BYTES) : plafond de la taille de dépôt (ADM-20)
  const limits = useQuery({
    queryKey: ['settings', 'limits'],
    queryFn: () => api.get<{ 'files.maxUploadBytes': { max: number } }>('/settings/limits'),
    enabled: can('settings.manage'),
    staleTime: 300_000,
  });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);

  if (!can('settings.manage')) return <Forbidden />;
  if (q.isLoading || !s) return q.error ? <ErrorState error={q.error} /> : <LoadingBlock rows={6} />;

  async function save<K extends keyof Settings>(key: K, value: Settings[K]) {
    try {
      await api.patch(`/settings/${key}`, { value });
      toast.success('Paramètre enregistré');
      qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const num = (k: NumberKey) => ({
    id: k,
    value: s[k],
    dirty: s[k] !== q.data?.[k],
    onChange: (v: number) => setS({ ...s, [k]: v }),
    onSave: () => save(k, s[k]),
  });
  const uploadMaxMb = Math.floor((limits.data?.['files.maxUploadBytes'].max ?? 500 * MB) / MB);

  return (
    <>
      <PageHeader title="Paramètres" description="Chaque modification est journalisée. Les valeurs métier non décidées par AMC (seuils financiers) restent à configurer dans leurs modules." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Sécurité des sessions">
          <NumberSetting {...num('auth.sessionIdleTimeoutMinutes')} label="Expiration après inactivité" hint="ADM-016 — appliquée à toutes les sessions" min={5} max={1440} unit="minutes" />
          <NumberSetting {...num('auth.maxFailedLogins')} label="Échecs avant verrouillage" hint="ADM-014 — 5 par décision AMC" min={3} max={10} />
          <NumberSetting {...num('auth.passwordMinLength')} label="Longueur minimale du mot de passe" hint="12 recommandé (pas de MFA, ADM-013)" min={10} max={128} unit="caractères" />
        </Panel>
        <Panel title="Fichiers et certificats">
          <NumberSetting
            {...num('files.maxUploadBytes')}
            value={Math.round(s['files.maxUploadBytes'] / MB)}
            onChange={(v) => setS({ ...s, 'files.maxUploadBytes': Math.round(v * MB) })}
            label="Taille maximale d'un dépôt"
            hint={`Entre 1 et ${limits.data ? uploadMaxMb : '…'} Mo — plafond imposé par la limite serveur fixée par l'environnement`}
            min={1}
            max={uploadMaxMb}
            unit="Mo"
          />
          <NumberSetting {...num('certificates.expiringSoonDays')} label="Seuil « expire bientôt »" hint="Statut d'affichage ; les rappels suivent la politique de chaque type" min={1} max={365} unit="jours" />
        </Panel>
        <Panel title="Coordonnées modifiables par l'utilisateur" actions={<Button size="sm" variant="secondary" onClick={() => save('members.selfEditableFields', s['members.selfEditableFields'])}>Enregistrer</Button>}>
          <p className="mb-3 text-sm text-ink-muted">ADM-035 — champs de la fiche Member qu’un utilisateur lié peut mettre à jour lui-même (effet immédiat, audité).</p>
          <div className="space-y-2">
            {SELF_FIELDS.map(([k, l]) => (
              <Checkbox
                key={k}
                label={l}
                checked={s['members.selfEditableFields'].includes(k)}
                onChange={(e) =>
                  setS({ ...s, 'members.selfEditableFields': e.target.checked ? [...s['members.selfEditableFields'], k] : s['members.selfEditableFields'].filter((x) => x !== k) })
                }
              />
            ))}
          </div>
        </Panel>
        <Panel title="Achats">
          <Checkbox
            label="Autoriser la sur-allocation explicite"
            description="Une quantité commandée supérieure à la quantité approuvée exige alors un motif et reste tracée. Désactivé par défaut (politique à confirmer par AMC)."
            checked={s['purchasing.allowOverAllocation']}
            onChange={(e) => {
              setS({ ...s, 'purchasing.allowOverAllocation': e.target.checked });
              save('purchasing.allowOverAllocation', e.target.checked);
            }}
          />
        </Panel>
      </div>
    </>
  );
}

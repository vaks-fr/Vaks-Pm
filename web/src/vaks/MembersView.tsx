/* ============================================================
   Vaks — Members view (read-only)
   Affiche, pour le projet courant :
     - les Project Managers
     - les autres membres directs (Contributor / Viewer / Guest)
     - les équipes assignées et leurs membres
   Lecture seule : aucune mutation. Les boutons d'édition (assigner
   un PM, ajouter / retirer une équipe, etc.) restent réservés aux
   rôles avec `project:assign_managers` via le ProjectsPanel.
   ============================================================ */
import React, { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Avatar, Icon } from './primitives';
import { api } from '../api/client';
import type { ProjectMemberDto } from '@vaks-pm/shared';

interface TeamLink {
  teamId: string;
  team: {
    id: string;
    name: string;
    color: string | null;
    members: Array<{ userId: string; user: { id: string; name: string; email: string } }>;
  };
}

const ROLE_META: Record<string, { labelKey: string; hue: number }> = {
  PROJECT_MANAGER: { labelKey: 'role.projectManager', hue: 285 },
  CONTRIBUTOR: { labelKey: 'role.contributor', hue: 178 },
  VIEWER: { labelKey: 'role.viewer', hue: 215 },
  GUEST: { labelKey: 'role.guest', hue: 25 },
};

function hueFromId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function RoleBadge({ roleKey }: { roleKey: string }) {
  const { t } = useTranslation();
  const meta = ROLE_META[roleKey];
  const label = meta ? t(meta.labelKey) : roleKey;
  const hue = meta?.hue ?? 250;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        padding: '3px 8px',
        borderRadius: 999,
        color: `oklch(0.45 0.14 ${hue})`,
        background: `oklch(0.95 0.05 ${hue})`,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  );
}

function PersonRow({
  name,
  email,
  userId,
  rightSlot,
}: {
  name: string;
  email: string;
  userId: string;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
    >
      <Avatar
        user={{
          id: userId,
          name,
          short: name.split(' ')[0],
          initials: initialsOf(name),
          role: '',
          hue: hueFromId(userId),
          online: false,
        }}
        size={32}
        title={false}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }} className="truncate">
          {name}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }} className="truncate">
          {email}
        </div>
      </div>
      {rightSlot}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section style={{ marginBottom: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 10,
          paddingBottom: 6,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h2>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {count} {count > 1 ? t('members.people') : t('members.person')}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>{children}</div>
    </section>
  );
}

export function MembersView({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<ProjectMemberDto[]>([]);
  const [teams, setTeams] = useState<TeamLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.listProjectMembers(projectId).catch((e) => {
        throw e;
      }),
      api.listProjectTeams(projectId).catch(() => [] as TeamLink[]),
    ])
      .then(([m, t]) => {
        if (cancelled) return;
        setMembers(m);
        setTeams(t as TeamLink[]);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>{t('members.loading')}</div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>
        {t('members.loadError', { error })}
      </div>
    );
  }

  const managers = members.filter((m) => m.role.key === 'PROJECT_MANAGER');
  const others = members.filter((m) => m.role.key !== 'PROJECT_MANAGER');
  // Membres "hérités" = membres d'une équipe assignée mais sans rôle direct sur le projet.
  const directIds = new Set(members.map((m) => m.userId));
  const inheritedByTeam = teams.map((t) => ({
    team: t.team,
    members: t.team.members.filter((tm) => !directIds.has(tm.userId)),
  }));

  return (
    <div style={{ padding: '20px 24px', maxWidth: 920, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{t('members.title')}</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-3)' }}>
          <Trans
            i18nKey="members.intro"
            values={{ project: projectName }}
            components={[<b />]}
          />
        </p>
      </div>

      {managers.length > 0 && (
        <Section title={t('members.projectManagers')} count={managers.length}>
          {managers.map((m) => (
            <PersonRow
              key={m.userId}
              userId={m.user.id}
              name={m.user.name}
              email={m.user.email}
              rightSlot={<RoleBadge roleKey={m.role.key} />}
            />
          ))}
        </Section>
      )}

      {others.length > 0 && (
        <Section title={t('members.directMembers')} count={others.length}>
          {others.map((m) => (
            <PersonRow
              key={m.userId}
              userId={m.user.id}
              name={m.user.name}
              email={m.user.email}
              rightSlot={<RoleBadge roleKey={m.role.key} />}
            />
          ))}
        </Section>
      )}

      {teams.length > 0 && (
        <section>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              marginBottom: 10,
              paddingBottom: 6,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{t('members.assignedTeams')}</h2>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {teams.length} {teams.length > 1 ? t('members.teams') : t('members.team')}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 16 }}>
            {inheritedByTeam.map(({ team, members: teamMembers }) => (
              <div
                key={team.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: 12,
                  background: 'var(--surface)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      background: team.color ?? 'var(--accent)',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{team.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {t('members.memberCount', { count: team.members.length })}
                  </div>
                </div>
                {teamMembers.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {t('members.allHaveDirectRole')}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 6 }}>
                    {teamMembers.map((tm) => (
                      <PersonRow
                        key={tm.userId}
                        userId={tm.user.id}
                        name={tm.user.name}
                        email={tm.user.email}
                        rightSlot={
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--text-3)',
                              fontStyle: 'italic',
                            }}
                          >
                            {t('members.via', { team: team.name })}
                          </span>
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {managers.length === 0 && others.length === 0 && teams.length === 0 && (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            color: 'var(--text-3)',
            fontSize: 13,
            border: '1px dashed var(--border)',
            borderRadius: 10,
          }}
        >
          <Icon name="users" size={22} />
          <div style={{ marginTop: 6 }}>{t('members.empty')}</div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Rendu Markdown → HTML minimal et SANS dépendance.

   Pourquoi maison plutôt qu'une lib : les notes de contexte projet sont du
   Markdown simple (titres, listes, code, tableaux) ; embarquer `marked` +
   `dompurify` alourdirait le bundle pour un aperçu. La règle de sûreté qui rend
   ça acceptable : **on échappe TOUT le HTML en entrée d'abord**, puis on ne
   ré-introduit que les balises qu'on génère nous-mêmes. Aucun HTML de l'auteur
   ne survit → pas de vecteur XSS. Les URLs de liens sont filtrées (http/https/
   mailto uniquement) pour bloquer `javascript:`.
   ============================================================ */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** N'autorise que les schémas d'URL inoffensifs. Sinon `#` (lien neutralisé). */
function safeHref(url: string): string {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u) || u.startsWith('/') || u.startsWith('#')) {
    return escapeHtml(u).replace(/"/g, '%22');
  }
  return '#';
}

/**
 * Sentinelle = caractère de contrôle U+0001, construit par code (aucun littéral
 * invisible dans la source). Il encadre l'index d'un code inline mis de côté ;
 * absent de tout texte réel, il évite la collision qu'un marqueur « espace-
 * chiffre-espace » provoquait avec un nombre du contenu (« étape 3 sur 5 »).
 */
const SENT = String.fromCharCode(1);

/** Rendu inline : code, gras, italique, liens. Entrée DÉJÀ échappée-HTML. */
function inline(text: string): string {
  let out = text;
  // Code inline — protégé en premier (son contenu n'est pas re-traité ensuite).
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push('<code>' + c + '</code>');
    return SENT + (codes.length - 1) + SENT;
  });
  // Liens [texte](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    return '<a href="' + safeHref(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  // Gras puis italique.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');
  // Réinjecte les codes via la sentinelle.
  out = out.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), (_m, i) => codes[Number(i)] ?? '');
  return out;
}

/**
 * Convertit du Markdown en HTML. Le résultat est destiné à `dangerouslySetInnerHTML`
 * — il est sûr car l'entrée est intégralement échappée avant tout balisage.
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  const para: string[] = [];
  const flushParagraph = () => {
    if (!para.length) return;
    html.push('<p>' + inline(escapeHtml(para.join(' '))) + '</p>');
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Bloc de code ```…```
    if (/^```/.test(line)) {
      flushParagraph();
      const fence: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) fence.push(lines[i++]);
      i++; // consomme la clôture
      html.push('<pre><code>' + escapeHtml(fence.join('\n')) + '</code></pre>');
      continue;
    }

    // Titre # … ######
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph();
      const level = h[1].length;
      html.push('<h' + level + '>' + inline(escapeHtml(h[2].trim())) + '</h' + level + '>');
      i++;
      continue;
    }

    // Règle horizontale
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      flushParagraph();
      html.push('<hr />');
      i++;
      continue;
    }

    // Citation > …
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push('<blockquote>' + inline(escapeHtml(quote.join(' '))) + '</blockquote>');
      continue;
    }

    // Tableau | a | b |  (ligne suivante = séparateur ---)
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      /-/.test(lines[i + 1])
    ) {
      flushParagraph();
      const cells = (row: string) =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const header = cells(line);
      i += 2; // saute l'entête + le séparateur
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      const thead =
        '<thead><tr>' + header.map((c) => '<th>' + inline(escapeHtml(c)) + '</th>').join('') + '</tr></thead>';
      const tbody =
        '<tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(escapeHtml(c)) + '</td>').join('') + '</tr>').join('') +
        '</tbody>';
      html.push('<table class="md-view-table">' + thead + tbody + '</table>');
      continue;
    }

    // Listes (à puces ou numérotées) — blocs contigus.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(
        '<' + tag + '>' + items.map((it) => '<li>' + inline(escapeHtml(it)) + '</li>').join('') + '</' + tag + '>',
      );
      continue;
    }

    // Ligne vide = fin de paragraphe.
    if (/^\s*$/.test(line)) {
      flushParagraph();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushParagraph();
  return html.join('\n');
}

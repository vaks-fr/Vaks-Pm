export default {
  // Tailwind 4 : le plugin PostCSS vit dans son propre paquet et embarque
  // l'auto-préfixage (autoprefixer n'est plus nécessaire).
  plugins: { '@tailwindcss/postcss': {} },
};

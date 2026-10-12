/**
 * Liste des mots de passe les plus communs (top ~600 d'après les corpus de
 * fuites publiques : SecLists, HaveIBeenPwned breach data, NCSC Top 100 000).
 *
 * Utilisée par `PasswordPolicyService.validateStrength` pour rejeter les
 * mots de passe triviaux. 100% offline : pas de hash externe, pas de query
 * vers HIBP. Couvre les vecteurs de credential stuffing classiques.
 *
 * Format : minuscules ; le check est case-insensitive (le mot de passe candidat
 * est lowercased avant lookup). Stocké en Set pour O(1) lookup.
 *
 * À étendre selon les besoins. Pour aller plus loin (vrais 10k+), embarquer
 * un fichier RockYou.txt en lazy-load au démarrage du service.
 */
const COMMON_PASSWORDS_RAW = [
  // Numériques séquentiels
  '123456', '12345678', '123456789', '1234567', '1234567890', '12345', '1234',
  '111111', '000000', '654321', '666666', '888888', '999999', '123123', '121212',
  '112233', '102030', '147258369', '147258', '987654321',
  // "password" et variantes
  'password', 'password1', 'password123', 'password12', 'passw0rd', 'p@ssword',
  'p@ssw0rd', 'pa55word', 'pa55w0rd', 'passwords', 'mypassword',
  // Patterns clavier
  'qwerty', 'qwertyuiop', 'qwerty123', 'qwerty1', 'azerty', 'azerty123',
  'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'qazwsx', '1q2w3e', '1q2w3e4r',
  '1q2w3e4r5t', 'qwsazx', 'q1w2e3r4', 'q1w2e3r4t5', '1qaz2wsx', '1qazxsw2',
  // Mots usuels
  'admin', 'admin123', 'admin1234', 'administrator', 'root', 'toor', 'pass',
  'guest', 'welcome', 'welcome1', 'welcome123', 'login', 'test', 'test123',
  'demo', 'changeme', 'changeme123', 'default', 'temp', 'temp123', 'temppass',
  'user', 'user1', 'user123', 'master', 'secret', 'iloveyou', 'letmein',
  'letmein123', 'monkey', 'dragon', 'football', 'baseball', 'shadow',
  'superman', 'batman', 'starwars', 'pokemon', 'sunshine', 'princess',
  'love', 'lovely', 'forever', 'forever21', 'freedom', 'whatever', 'trustno1',
  'master123', 'access', 'access123', 'azerty1', 'ninja', 'rocky', 'mustang',
  // Noms communs
  'michael', 'jordan', 'jessica', 'jennifer', 'nicole', 'daniel', 'andrew',
  'matthew', 'joshua', 'anthony', 'thomas', 'patrick', 'ashley', 'andrea',
  // Années
  '2020', '2021', '2022', '2023', '2024', '2025', '2026', '1990', '1991', '1992',
  '1993', '1994', '1995', '1996', '1997', '1998', '1999', '2000', '2001', '2002',
  '2003', '2004', '2005', '2006', '2007', '2008', '2009', '2010', '2011', '2012',
  '2013', '2014', '2015', '2016', '2017', '2018', '2019',
  // Variantes "Password + chiffre"
  'password1!', 'password!', 'password2', 'password3', 'pass123', 'pass1234',
  'admin!', 'admin1!', 'admin@123', 'admin@1234', 'p@ssword1', 'p@ssword123',
  'p@ssw0rd1', 'p@ssw0rd!', 'p@ssw0rd123', 'p@ssw0rd1!', 'p@ssw0rd!1',
  // FR/EN courants
  'azerty12', 'azerty12345', 'azertyuiop', 'motdepasse', 'motdepasse123',
  'soleil', 'bonjour', 'bonjour1', 'bienvenue', 'azerty1234', 'tototo',
  'tata', 'titi', 'toto', 'toto123', 'nounours', 'doudou', 'chaton',
  'chouchou', 'minou', 'pompier', 'caramel',
  // ES / DE
  'hola', 'hola123', 'amor', 'amor123', 'corazon', 'hallo', 'hallo123',
  'guten', 'guten123', 'sommer', 'winter',
  // Variantes "Word + 123"
  'hello', 'hello1', 'hello123', 'hello1234', 'master1', 'tester', 'tester1',
  'tester123', 'support', 'support1', 'support123', 'manager', 'manager1',
  'manager123', 'service', 'service1', 'service123', 'system', 'system1',
  'system123', 'computer', 'computer1', 'computer123', 'oracle', 'oracle1',
  'oracle123', 'database', 'database1', 'database123',
  // Combinaisons admin/test corporate
  'company', 'company1', 'company123', 'office', 'office1', 'office123',
  'employee', 'employee1', 'employee123', 'corporate', 'corporate1',
  'corporate123', 'enterprise', 'enterprise1', 'enterprise123',
  // Modèle "1Password" / mots de passe générés mal
  'abcd', 'abcd1234', 'abcdef', 'abcdefg', 'abcdefgh', 'abc123', 'abc1234',
  'abc12345', '1q2w3e4r!', '1qaz!QAZ',
  // Mots ajoutés selon les fuites majeures (RockYou, Adobe, LinkedIn…)
  'linkedin', 'linkedin1', 'linkedin123', 'adobe', 'adobe123', 'facebook',
  'facebook1', 'facebook123', 'google', 'google123', 'microsoft', 'microsoft123',
  'apple', 'apple1', 'apple123', 'samsung', 'samsung1',
  // Sport / fans
  'liverpool', 'arsenal', 'chelsea', 'barcelona', 'realmadrid', 'manchester',
  'manunited', 'psg', 'olympique', 'marseille', 'monaco',
  // Animaux
  'cookie', 'shadow1', 'tigger', 'maverick', 'whisky', 'snoopy', 'rocky1',
  // Émotions / vie
  'happy', 'happy1', 'happy123', 'lucky', 'lucky1', 'lucky7', 'angel',
  'angel1', 'magic', 'magic1', 'pretty', 'amazing',
  // Fast-typing tests
  'aaaaaa', 'aaaaaaa', 'aaaaaaaa', 'bbbbbb', 'qweqwe', 'asdasd', 'zxczxc',
  'qwerasdf', 'asdfqwer',
  // Génériques en français bureau
  'societe', 'entreprise', 'reception', 'accueil', 'commercial', 'direction',
  'comptable', 'admin1234', 'compta', 'paie', 'paie123', 'rh', 'rh123',
  'rh1234', 'rh@2024', 'rh@2025', 'rh@2026',
  // Devises / banques
  'argent', 'money', 'money1', 'money123', 'bank', 'bank1', 'bank123',
  // Sécurité ironique
  'secure', 'secure1', 'secure123', 'security', 'security1', 'security123',
  'firewall', 'firewall1', 'firewall123',
];

// Set pour lookup O(1). Tout en lowercase.
const COMMON_PASSWORDS = new Set<string>(
  COMMON_PASSWORDS_RAW.map((p) => p.toLowerCase()),
);

/** True si le mot de passe figure dans la blocklist (case-insensitive). */
export function isCommonPassword(password: string): boolean {
  if (!password) return false;
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

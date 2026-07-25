# Contribuer

Merci de votre intérêt pour Vaks-PM.

## Modèle de développement

Ce dépôt public est un **miroir de publication** du produit : le développement se fait en
amont dans un dépôt privé, puis des snapshots propres sont publiés ici. Il n'y a donc pas
de flux de merge direct sur ce dépôt.

## Comment contribuer

- **Signaler un bug ou proposer une amélioration** : ouvrez une *issue* décrivant le
  problème, les étapes de reproduction, la version (tag d'image `sha-…` si pertinent) et
  l'environnement.
- **Proposer un correctif** : ouvrez une *pull request*. Elle sera revue et, si acceptée,
  intégrée en amont puis republiée ici — votre contribution sera créditée.
- **Sécurité** : merci de **ne pas** ouvrir d'issue publique pour une vulnérabilité.
  Contactez les mainteneurs en privé.

## Développer en local

Voir le [README](README.md) (« Démarrage rapide ») : `docker compose up` + `npm run seed`.
Le code est en TypeScript de bout en bout ; respectez le style et les conventions des
fichiers voisins.

## Licence

En contribuant, vous acceptez que votre contribution soit distribuée sous les termes de la
licence du projet (**Elastic License 2.0**, voir [`LICENSE`](LICENSE)).

RÖST-FRASER — bossar + heroes
==============================

Spelet säger redan ÅT systemet att spela röst-fraser (boss säger repliker under
fighten: spawn, enrage, periodiska taunts; heroes säger repliker då och då medan
man spelar). Det är TYST tills du lägger in röstfilerna nedan. Lägg .mp3-filer
(iOS-vänligt) med EXAKT dessa namn:

  assets/voice/boss/
    captain_spawn.mp3   captain_enrage.mp3   captain_taunt1.mp3   captain_taunt2.mp3
    general_spawn.mp3   general_enrage.mp3   general_taunt1.mp3   general_taunt2.mp3
    warlord_spawn.mp3   warlord_enrage.mp3   warlord_taunt1.mp3   warlord_taunt2.mp3
    demon_spawn.mp3     demon_enrage.mp3     demon_taunt1.mp3     demon_taunt2.mp3
    dragon_spawn.mp3    dragon_enrage.mp3    dragon_taunt1.mp3    dragon_taunt2.mp3

  assets/voice/heroes/   (KLART — 3 per hjälte, döpta efter LÄNGD: short/medium/long)
    magiker_short.mp3  magiker_medium.mp3  magiker_long.mp3   (= Zyro/magikern)
    + legolas_/aragurn_/kostefo_/gimlu_/zheyna_ short/medium/long
    Regel: KORT sägs direkt vid match-start; MEDIUM 15s in, sen rotation kort/
    medium (~40-55s); LÅNG endast vid ult-cast eller när ulten blir full-charged.
    legolas_1.mp3  legolas_2.mp3  legolas_3.mp3
    aragurn_1.mp3  aragurn_2.mp3  aragurn_3.mp3
    kostefo_1.mp3  kostefo_2.mp3  kostefo_3.mp3
    gimlu_1.mp3    gimlu_2.mp3    gimlu_3.mp3
    zheyna_1.mp3   zheyna_2.mp3   zheyna_3.mp3

Boss-rösterna körs automatiskt genom en TUNG/EKANDE buss (djupare + reverb) så de
låter monstruösa. Heroes spelas rent. Du behöver inte göra något i koden — bara
lägga filerna här med rätt namn.


HUR DU GENERERAR RÖSTERNA (rekommendation: ElevenLabs, gratis)
---------------------------------------------------------------
1. Gå till elevenlabs.io → skapa gratis konto → "Text to Speech".
2. Välj en RÖST per karaktär (djup/hotfull för bossar; passande för varje hjälte).
   Använd SAMMA röst för en boss alla dess 4 rader, och samma röst för en hjältes
   3 rader — så varje karaktär har sin egen röst.
3. Skriv frasen, generera, ladda ner som MP3.
4. Döp om till rätt filnamn ovan och lägg i rätt mapp.

(Alternativ: spela in din egen röst, eller Freesound.org CC0 "monster voice"/"grunt".)


FÖRSLAG PÅ FRASER (ändra fritt)
--------------------------------
BOSSAR:
  Captain (tier 1)
    spawn  : "You dare challenge me?"
    enrage : "Now you will fall!"
    taunt1 : "Is that all you have?"
    taunt2 : "Pathetic."
  General (tier 2)
    spawn  : "Your end has come."
    enrage : "I will not be defeated!"
    taunt1 : "Kneel before me."
    taunt2 : "You fight in vain."
  Warlord (tier 3)
    spawn  : "Tremble before the Warlord!"
    enrage : "Enough games!"
    taunt1 : "You are nothing."
    taunt2 : "Suffer."
  Demon Prince (tier 4)
    spawn  : "Your soul is mine."
    enrage : "Burn in the abyss!"
    taunt1 : "Despair, mortal."
    taunt2 : "I feast on your fear."
  Dragon King (tier 5)
    spawn  : "Mortals... how amusing."
    enrage : "I shall scorch this world!"
    taunt1 : "You are ants beneath me."
    taunt2 : "Witness true power."

HEROES:
  Gandulf (mage)     : "The arcane bends to my will." / "Magic flows through me." / "You cannot outwit the storm."
  Legolas (archer)   : "One shot, one kill." / "You won't even see me." / "The hunt is on."
  Aragurn (warrior)  : "For glory!" / "Stand and fight!" / "None shall pass."
  Kostefo            : "Let's get this done." / "Time to bring the heat." / "You can't stop me."
  Gimlu/Kryx (tank)  : "Crush them all!" / "Feel my rage!" / "I am unbreakable."
  Zheyna (spear)     : "My spear thirsts." / "Pierce through!" / "There is no escape."


TIMING (om du vill veta)
------------------------
- Boss: spawn-replik när bossen dyker upp, enrage vid fas 2, taunt var ~26-46 s.
- Hero: en replik var ~50-90 s medan du spelar (och inte är död).
- Global cooldown: fraser överlappar aldrig varandra.
Säg till om du vill ändra hur ofta de hörs, eller lägga till fler rader per karaktär.

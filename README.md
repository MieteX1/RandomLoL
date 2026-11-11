# Losowy Champ

Strona losuje championa na wybraną rolę oraz 6 przedmiotów (w tym buty),
ale tylko spośród tych, które realnie pojawiają się w statystykach Lolalytics
dla danego championa na danej roli (Emerald+, Solo/Duo).

## Uruchomienie

1. Zainstaluj Node.js 18 lub nowszy.
2. W tym folderze uruchom:

       node scrape.mjs

   Skrypt pobiera dane (kilka–kilkanaście minut, celowo wolno, żeby nie obciążać Lolalytics)
   i tworzy plik `data.js`. Robisz to raz na patch.
3. Otwórz `index.html` w przeglądarce (wystarczy dwuklik, serwer niepotrzebny).

## Opcje skryptu

    node scrape.mjs --only Jinx,Ashe,Zeri    # szybki test na kilku championach
    node scrape.mjs --min-games 1000          # bardziej "poważne" picki
    node scrape.mjs --min-lane-pct 5          # champion musi grać tę rolę w >=5% gier
    node scrape.mjs --delay 800               # wolniej, ostrożniej

## Jak to działa

- Lista championów i przedmiotów (nazwy, ikony, co jest "gotowym" itemem) pochodzi z Riot Data Dragon.
- Dla każdego championa skrypt otwiera stronę buildu na Lolalytics, odczytuje, na jakich rolach jest grany,
  a potem dla każdej roli powyżej progów zbiera listę itemów występujących w jego statystykach.
- Strona losuje championa z roli i 5 itemów + 1 buty z tej puli.

## Jeśli coś nie działa

Skrypt parsuje HTML Lolalytics, więc zmiana układu strony może go zepsuć. Skrypt wypisuje ostrzeżenia
(`!`) przy championach, dla których nic nie znalazł. Najczęstsze poprawki są w funkcjach
`parseLanePercents` i `parseBuildPage` w `scrape.mjs`.
Championowie nowsi niż aktualna wersja Data Dragon mogą się nie pojawić.

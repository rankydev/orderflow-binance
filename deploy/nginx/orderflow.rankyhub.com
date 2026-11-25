# Ziel: /etc/nginx/sites-available/orderflow.rankyhub.com (+ Symlink in sites-enabled)
# Öffentlich, ohne Authentifizierung (KONZEPT §10.2). Schutz ohne Passwort: Rate-Limit je IP auf
# /api/ (Zonen in conf.d/orderflow-binance.conf), keine schreibenden Endpunkte, /api/v1/health nicht
# nach außen. TLS wie genius/takt: certbot webroot, Zertifikat unter /etc/letsencrypt/live/<name>/.
#
# Bewusst NICHT gesetzt:
#  - default_server: Standardserver je Socket ist der erste Server in Include-Reihenfolge; das ist
#    auf allen vier Sockets (80, [::]:80, 443, [::]:443) genius.rankyhub.com (Survey 2026-11-25).
#    Der Symlink heißt sites-enabled/zz-orderflow.rankyhub.com und sortiert immer als letzter.
#    Die listen-Zeilen spiegeln die der Nachbarn (genius/takt): 80, [::]:80, 443 ssl, [::]:443 ssl;
#    wir öffnen keinen Socket, den nicht schon ein Nachbar hat.
#  - http2 (vom Web-Review empfohlen): in nginx 1.18 ist http2 eine Option des Listen-Sockets
#    (0.0.0.0:443 / [::]:443) und gälte damit für ALLE Sites dort (genius, rankyhub, takt) – das
#    wäre eine Änderung an den Nachbarn. Offen zur Entscheidung des Nutzers; Umsetzung dann:
#    `listen 443 ssl http2;` und `listen [::]:443 ssl http2;` hier. HTTP/1.1 mit 6 Verbindungen je
#    Host reicht für die 2 × 4 parallelen Client-Anfragen.
#  - HSTS: die übrigen Sites setzen es nicht.
#  - ipv6only o. ä. Socket-Optionen: die setzt bereits rankyhub.com für [::]:443.
#  - proxy_cache: nginx cacht API-Antworten (noch) nicht; ETag/Cache-Control/Content-Encoding der
#    API gehen unverändert durch (finale Kacheln max-age=604800, sonst no-cache).

# Upstream mit Keep-Alive. Regel: nginx schließt untätige Upstream-Verbindungen FRÜHER als die API
# (keepalive_timeout 60 s < OF_API_KEEPALIVE_TIMEOUT_MS 65 s), sonst verwendet nginx eine Verbindung,
# die Node gerade schließt → sporadische 502. Name mit Präfix orderflow_ (kein anderer Upstream).
upstream orderflow_api_upstream {
    server 127.0.0.1:8780 max_fails=0;
    keepalive 16;
    keepalive_timeout 60s;
    keepalive_requests 1000;
}

server {
    listen 80;
    listen [::]:80;
    server_name orderflow.rankyhub.com;

    access_log off;
    error_log /var/log/nginx/orderflow-error.log warn;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/orderflow-acme;
        default_type text/plain;
    }
    location / {
        return 308 https://orderflow.rankyhub.com$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name orderflow.rankyhub.com;

    ssl_certificate /etc/letsencrypt/live/orderflow.rankyhub.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/orderflow.rankyhub.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    access_log /var/log/nginx/orderflow-access.log;
    error_log /var/log/nginx/orderflow-error.log warn;

    # server_tokens ist global nicht gesetzt (Survey) → nur für diesen Server aus
    server_tokens off;
    # Die API nimmt keine Körper an; GET/HEAD/OPTIONS genügen überall
    client_max_body_size 1k;
    client_body_timeout 10s;
    if ($request_method !~ ^(GET|HEAD|OPTIONS)$) {
        return 405;
    }

    root /opt/orderflow-binance/current/web;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    # Tiles (application/octet-stream) und JSON liefert die API meist schon gzip-komprimiert aus
    # ihrem Cache; nginx komprimiert nur, was ohne Content-Encoding ankommt (Sicherheitsnetz).
    gzip_types text/css application/javascript text/javascript application/json
               application/octet-stream image/svg+xml text/plain;

    include /etc/nginx/snippets/orderflow-binance-headers.conf;

    # Versteckte Dateien nie ausliefern
    location ~ /\. {
        return 404;
    }

    # Vite-Assets tragen einen Inhalts-Hash im Namen → unveränderlich
    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        include /etc/nginx/snippets/orderflow-binance-headers.conf;
    }

    # Einstieg: immer revalidieren (zeigt nach einem Release-Wechsel sofort die neuen Assets)
    location = /index.html {
        add_header Cache-Control "no-cache" always;
        include /etc/nginx/snippets/orderflow-binance-headers.conf;
    }

    location / {
        try_files $uri /index.html;
    }

    # Health/Status nie von außen (Auflage aus dem API-Review), unabhängig vom Verhalten der API;
    # die API bedient den Detail-Health nur auf ihrem Loopback-Listener 127.0.0.1:8781 im Container.
    location = /api/v1/health {
        return 404;
    }
    location ^~ /api/v1/health/ {
        return 404;
    }

    # /api/v1/quality: ohne Server-Cache und ohne Zusammenfassen gleicher Anfragen (bis 1 100 Tage,
    # bis 20 000 Zeilen, belegt bis 5 s einen der 4 Limiter-Plätze der API) → eigene, strenge Zone,
    # damit eine Flut davon Kacheln/Profile nicht mit 503 verdrängt. Die Web-App nutzt es noch nicht.
    location /api/v1/quality {
        limit_req zone=orderflow_quality burst=5 nodelay;
        limit_req_status 429;
        limit_conn orderflow_conn 32;
        limit_conn_status 429;
        include /etc/nginx/snippets/orderflow-binance-proxy.conf;
    }

    location /api/ {
        # STELLSCHRAUBE 2/2: Burst (Rate = Stellschraube 1 in conf.d/orderflow-binance.conf).
        # 30 r/s + Burst 90 ohne Verzögerung: Seitenstart (≈ 30 Anfragen) und schnelles Schwenken
        # (≤ 40 r/s kurzzeitig) bleiben darunter; 429 behandelt der Client mit Backoff/Retry-After.
        limit_req zone=orderflow_api burst=90 nodelay;
        limit_req_status 429;
        # Browser öffnen über HTTP/1.1 ≤ 6 Verbindungen je Host; 32 lässt mehrere Tabs/NAT zu
        limit_conn orderflow_conn 32;
        limit_conn_status 429;

        include /etc/nginx/snippets/orderflow-binance-proxy.conf;
    }

    location @orderflow_429 {
        default_type application/json;
        add_header Retry-After 1 always;
        include /etc/nginx/snippets/orderflow-binance-headers.conf;
        return 429 '{"error":"zu viele Anfragen"}\n';
    }
    location @orderflow_502 {
        default_type application/json;
        add_header Retry-After 5 always;
        include /etc/nginx/snippets/orderflow-binance-headers.conf;
        return 502 '{"error":"API nicht erreichbar"}\n';
    }
    location @orderflow_503 {
        default_type application/json;
        add_header Retry-After 5 always;
        include /etc/nginx/snippets/orderflow-binance-headers.conf;
        return 503 '{"error":"API überlastet"}\n';
    }
}

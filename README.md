# ImgGen — Substituto do NiftyImages

Painel visual para gerar imagens dinâmicas com nome personalizado.
Funciona como backend para Cloudflare Worker + GHL + WhatsApp.

---

## Instalação no VPS (Ubuntu 22/24)

### 1. Instalar Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clonar / copiar os arquivos
```bash
mkdir ~/imggen && cd ~/imggen
# copie server.js, package.json e a pasta public/
```

### 3. Instalar dependências
```bash
npm install
```

### 4. Instalar PM2 (mantém rodando em background)
```bash
npm install -g pm2
pm2 start server.js --name imggen
pm2 save
pm2 startup
```

### 5. Instalar Nginx
```bash
sudo apt install nginx -y
```

### 6. Configurar Nginx (troque `img.seudominio.com`)
```nginx
# /etc/nginx/sites-available/imggen
server {
    listen 80;
    server_name img.seudominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 20M;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/imggen /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 7. SSL grátis com Certbot
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d img.seudominio.com
```

---

## Uso

### Painel (adicionar/editar templates)
```
https://img.seudominio.com
```

### Gerar imagem (endpoint)
```
https://img.seudominio.com/render?template=ivens&name=Bruno
```

---

## Cloudflare Worker (atualizado)

Troque a URL do NiftyImages pela sua API:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") || "Cliente";
    const template = url.searchParams.get("template") || "default";

    const apiUrl = `https://img.seudominio.com/render?template=${template}&name=${encodeURIComponent(name)}`;

    const response = await fetch(apiUrl);
    const imageBuffer = await response.arrayBuffer();

    return new Response(imageBuffer, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600"
      }
    });
  }
}
```

No GHL, o link do template do WhatsApp fica:
```
https://worker.seudominio.com?template=ivens&name={{contact.first_name}}
```

---

## Estrutura de arquivos

```
imggen/
├── server.js          ← API + servidor
├── package.json
├── public/
│   └── index.html     ← Painel visual
└── templates/
    ├── ivens.jpg      ← Foto do cliente
    ├── ivens.json     ← Config da caixa/texto
    ├── nutricionista.jpg
    └── nutricionista.json
```

---

## Custo estimado
| Item | Custo |
|------|-------|
| VPS básico (Hostinger/DigitalOcean) | R$ 20–40/mês |
| Domínio | R$ 40–80/ano |
| Node.js, Sharp, PM2, Nginx, SSL | Gratuito |
| **Total** | **~R$ 25–45/mês** |

vs NiftyImages: **US$25/mês (~R$140)**

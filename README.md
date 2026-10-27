# PokéRogue Streak Client

포케로그 기반 연승전 클라이언트입니다. 기본 게임/공통 대전 엔진은 **1.12.2.0**이며, 1.12.1.2·1.12.1.3 엔진도 함께 제공합니다. 루트 `package.json`의 1.12.1.3은 PvP 애드온의 기준 엔진입니다.

서버: [pokerogue-streak-server](https://github.com/aksmfosef11/pokerogue-streak-server). 원본: [pagefaultgames/pokerogue](https://github.com/pagefaultgames/pokerogue).

## 최초 실행

Git, Docker Compose v2, Node.js 24.9 이상을 사용합니다. 두 저장소를 `client`, `server`라는 이름의 형제 폴더로 받습니다.

```sh
git clone --recurse-submodules https://github.com/aksmfosef11/pokerogue-streak-client.git client
git clone https://github.com/aksmfosef11/pokerogue-streak-server.git server
cd client
node deployment/prepare-media.mjs
cp deployment/.env.example deployment/.env
# deployment/.env에 새 DB 암호 두 개와 실제 접속 주소를 입력합니다.
cd deployment
docker compose -f compose.pvp.yml config --quiet
docker compose -f compose.pvp.yml build
docker compose -f compose.pvp.yml up -d --wait
```

PowerShell에서는 `cp` 대신 `Copy-Item`을 사용할 수 있습니다. 게이트웨이는 `127.0.0.1:8000`에 열립니다. 외부 서비스에서는 HTTPS 프록시를 이 포트로 연결하고 `PVP_PUBLIC_URL`을 해당 도메인으로 지정합니다. API는 같은 도메인의 `/api/`로 전달합니다.

`deployment/native/`는 각 공식 태그를 기반으로 한 실제 엔진 소스입니다. 미디어는 `.gitmodules`와 `deployment/media-pins.json`에 고정하고, 변경한 로고·번역은 `deployment/media-overrides/`에 보관합니다. `prepare-media.mjs` 실행 후 빌드해야 이 변경이 적용됩니다.

데이터는 `pokerogue-streak_database`, `pokerogue-streak_pvp-data` Docker 볼륨에 저장됩니다. 기존 운영 볼륨을 사용하는 재배포에서는 기존 DB 암호를 사용합니다. SQL/키/백업과 운영 인증 정보는 저장소에 포함하지 않습니다.

원본 `LICENSE`, `LICENSES`, `CREDITS.md`, 파일별 저작권 표기를 유지합니다. 아래는 원본 프로젝트 안내입니다.

---

<!--
SPDX-FileCopyrightText: 2024-2026 Pagefault Games

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

<div align="center"><picture><img src="https://github.com/pagefaultgames/pokerogue-assets/blob/beta/images/logo.png?raw=true" width="300" alt="PokéRogue"></picture>

[![Discord Static Badge](https://img.shields.io/badge/Community_Discord-blurple?style=flat&logo=discord&logoSize=auto&labelColor=white&color=5865F2)](https://discord.gg/pokerogue)
[![Test Coverage Endpoint Badge](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Bertie690/9cdfc49361824d1d5a57b7e8b38855d8/raw/coverage-badge.json)](https://github.com/pagefaultgames/pokerogue/actions/workflows/tests.yml) \
[![Docs Coverage Static Badge](https://pagefaultgames.github.io/pokerogue/beta/coverage.svg)](https://pagefaultgames.github.io/pokerogue/beta)
[![Biome Linting Static Badge](https://img.shields.io/badge/Linted_with-Biome-60a5fa?style=flat&logo=biome)](https://biomejs.dev)
[![GNU AGPLv3 License Static Badge](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
</div>

PokéRogue is a browser based Pokémon fangame heavily inspired by the roguelite genre. Battle endlessly while gathering stacking items, exploring many different biomes, fighting trainers, bosses, and more!

# Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md), this includes instructions on how to set up the game locally.

# 📝 Credits

> If this project contains assets you have produced and you do not see your name, **please** reach out, either [here on GitHub](https://github.com/pagefaultgames/pokerogue/issues/new) or via [Discord](https://discord.gg/pokerogue).

Thank you to all the wonderful people that have contributed to the PokéRogue project! You can find the credits [here](./CREDITS.md).

# Licensing

This repository seeks to be [REUSE compliant](https://reuse.software/): copyright and/or licensing information for each file is stored
either in the file itself or in an associated `REUSE.toml` file.

The full licensing information for each file can be found by utilizing [REUSE's tooling](https://github.com/fsfe/reuse-tool), such as via `reuse spdx`. \
An abbreviated summary of said information is as follows:
- All source code belonging to the project, unless otherwise noted, is licensed under [AGPL-v3.0-only](LICENSES/AGPL-3.0-only.txt).
- All forms of documentation (both Markdown files[^1] and any comments explicitly documenting source code) are licensed under [CC-BY-NC-SA-4.0](LICENSES/CC-BY-NC-SA-4.0.txt).
- Auto-generated files produced by external tools or files of insignificant originality are not copyrighted and are licensed under [CC0-1.0](LICENSES/CC0-1.0.txt).
- To the extent that the assets we provide are [licensable and applicable](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.en#ref-exception-or-limitation), they are licensed under [CC-BY-NC-SA-4.0](LICENSES/CC-BY-NC-SA-4.0.txt) unless otherwise noted.
  Exceptions can be found in associated `REUSE.toml` files.
  - ⚠️ Files in `assets/` that are not explicitly licensed via `REUSE.toml` files should be considered to have _no_ licensing / copyright information.

[^1]: Including this README

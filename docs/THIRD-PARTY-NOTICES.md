# 외부 소프트웨어 고지

Engine Lab 1.0.0은 Three.js **0.180.0**과 Three.js 예제 모듈을 사용한다. MIT 라이선스 전문은 소스의 `public/THREE-LICENSE.txt`, 빌드의 `dist/THREE-LICENSE.txt`, Windows 설치 폴더의 `resources/THREE-LICENSE.txt`에 포함한다. 재배포할 때 고지를 유지한다. [Three.js r180 원본 라이선스](https://github.com/mrdoob/three.js/blob/r180/LICENSE)

Windows 앱은 Electron **44.5.1** 실행 환경과 그 안의 Chromium·Node.js 및 관련 구성요소를 포함하도록 구성한다. 설치 폴더의 `LICENSE.electron.txt`와 `LICENSES.chromium.html`은 Electron·Chromium 및 포함 구성요소의 고지이다. 이 파일들도 앱과 함께 유지해야 한다. 의존성의 정확한 버전은 `package-lock.json`에 고정한다.

Vite **7.3.6**, Playwright **1.63.0**, electron-builder **26.15.3**은 개발·빌드·검증 도구이다. 해당 개발 도구의 실행 패키지는 Windows 앱에 포함하지 않는다. 빌드 결과 JavaScript와 Electron 실행 환경은 포함한다.

엔진 형상과 환경은 앱 코드로 생성한다. 외부 CAD, 제조사 사진, 카탈로그, 폰트 또는 HDR 파일을 배포하지 않는다. 참고 자료의 링크는 설명을 위한 것이며 해당 자료의 이미지·도면을 앱에 복제하지 않는다.

아이콘은 `scripts/create-icon.py`의 자체 도형으로 생성한다. 이 선택적 제작 도구는 Pillow를 사용한다. 생성된 PNG·ICO 파일을 앱에 포함하며 Pillow 자체는 앱의 실행 구성요소에 포함하지 않는다. Python이나 Pillow는 앱 실행·설치에 필요하지 않다.

이 문서는 외부 라이브러리 고지이다. 앱 전체에 MIT 또는 다른 소스 사용 허가를 부여하지 않는다. 앱 자체의 권리·판매 조건·상표·지원 정책은 제품 소유자가 별도로 정한다. 프로젝트의 `UNLICENSED` 표기를 유지한다.

각 배포 후보의 설치 검증에서 위 라이선스 파일과 설치 폴더의 `resources/docs` 및 `resources/사용 안내.txt` 존재를 확인한다. 라이선스 고지의 포함 여부와 제품의 기능·사용성 평가는 별도로 기록한다.

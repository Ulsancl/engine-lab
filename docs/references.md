# Engine Lab 참고 자료와 자체 설정

확인일: 2026-10-01. 아래 자료는 엔진 원리를 확인하기 위해 읽었다. 그림·사진·CAD·동영상·소스 코드를 앱에 복제하지 않았으며, 기관이나 제조사가 Engine Lab을 검증하거나 추천한다는 의미가 아니다. 앱의 기구 형상과 계산 코드는 자체 작성했다. 포함한 소프트웨어의 라이선스는 [외부 소프트웨어 고지](THIRD-PARTY-NOTICES.md)에 별도로 정리한다.

| 1차 자료 | 참고한 원리 | Engine Lab에 적용한 범위 |
|---|---|---|
| [Briggs & Stratton — How a 4-Stroke Engine Works](https://www.briggsandstratton.com/en-us/support/videos/4-stroke-theory) | 흡기·압축·팽창·배기가 반복하고 한 사이클에 크랭크가 두 바퀴 회전한다. | 네 행정의 순서와 720° 관찰 기준. 자료의 소형 OHV 배치·기화기·제품 치수를 이 앱의 DOHC 설계로 옮기지 않았다. |
| [NITK Virtual Labs — Dynamic Analysis of Slider Crank Mechanism](https://dom-nitk.vlabs.ac.in/exp/slider-crank-mechanism/theory.html) | 크랭크와 로드의 링크 길이에 따른 위치 구속을 먼저 다루고, 속도·가속도·힘 분석을 구분한다. | 두 핀의 연결 거리로 직접 유도한 위치식. 힘·관성·토크 해석이나 해당 사이트의 코드·도해는 포함하지 않았다. |
| [Toyota — Toyota Develops New VVT-i Engine Technology](https://global.toyota/en/detail/7893162) | 흡기 타이밍을 앞당기거나 늦추면 열림·닫힘과 오버랩이 변하며, 실제 성능 효과는 운전 조건에 의존한다. | 고정 배기 이벤트와 흡기 위상 ±10°의 비교 실험. Toyota의 제어기·유압 기구·각도 범위·성능 수치는 재현하지 않았다. |
| [MIT OpenCourseWare — 2.61 Internal Combustion Engines, Spring 2017](https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/) | 엔진의 동작·열역학·연소·유동·열전달·마찰은 서로 구분되는 해석 주제다. | 현재 제품의 범위를 기구 운동과 순서 관찰로 제한하는 근거. 이 강의의 압력·성능 모델이나 그림을 앱에 포함하지 않았다. |
| [Honda — Engine Oil](https://global.honda/en/motorcycle-aftersales/maintenance/engineoil.html) | 펌프로 공급되는 엔진 오일은 윤활·냉각 등 여러 역할을 한다. | 오일 공급 위치와 순환 방향을 설명하는 대표 경로. 특정 Honda 엔진의 통로·유량·유압·온도는 재현하지 않았다. |

보어·행정 86 mm, 로드 길이 143 mm, 1-3-4-2 팽창 순서, 최대 밸브 리프트 6 mm, 흡기 350–580°·배기 140–370°, `sin²` 리프트와 지지함수 기반 캠은 이 앱을 위해 정한 대표 설정이다. 위 자료에서 특정 완성 엔진의 사양을 추출한 값이 아니다. 캠과 팔로워의 접촉 관계 및 시간 환산은 [계산 모형](model.md)의 식과 독립적인 수치 검사로 확인한다.

형상·수치가 원리를 설명하기에 일관되는지와 실제 제조·연소 성능을 검증했는지는 별개의 문제다. 첫 공개판의 완료 기준과 남는 한계는 [공개 범위](release-scope.md)를 따른다.

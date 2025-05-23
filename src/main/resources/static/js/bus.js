let busMarkers = [];
let busTimer = null;
let stopMarkers = [];
let allStops = [];
let clusterer;
let routeLine = null;
let routeMarkers = [];
window.routeMarkers = routeMarkers;
let arrivalTimers = {};
let visibleStops = [];     // 현재 지도 내 표시되는 정류소
let routeStops = [];       // 검색한 노선의 정류소
let currentRouteId = null; // 현재 활성화된 노선 ID

const typeColorMap = {
  "간선": "bg-primary",
  "지선": "bg-success",
  "광역": "bg-danger",
  "마을": "bg-warning",
  "순환": "bg-info",
  "공항": "bg-dark",
  "경기": "bg-secondary",
  "인천": "bg-secondary",
  "기타": "bg-light text-dark"
};

// 🔹 기존 마커 제거
function clearBusMarkers() {
  busMarkers.forEach(marker => marker.setMap(null));
  busMarkers = [];
}

async function showBusPositions({ routeId, routeNumber }) {
  let url = '';
  if (routeId) {
    url = `/api/proxy/busPos?routeId=${encodeURIComponent(routeId)}`;
  } else if (routeNumber) {
    url = `/api/proxy/busPosByNumber?routeNumber=${encodeURIComponent(routeNumber)}`;
  } else {
    alert("버스 노선 정보가 부족합니다 (routeId 또는 routeNumber)");
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 호출 실패: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.msgHeader || data.msgHeader.headerCd !== '0') {
      clearBusMarkers();
      alert('버스 위치 데이터를 가져오지 못했습니다: ' + (data.msgHeader?.headerMsg || '서버 오류'));
      return;
    }

    const itemList = data?.msgBody?.itemList;
    const buses = Array.isArray(itemList) ? itemList : (itemList ? [itemList] : []);

    if (buses.length === 0) {
      clearBusMarkers();
      alert('현재 운행 중인 버스가 없습니다.');
      return;
    }

    clearBusMarkers();

    buses.forEach(bus => {
      const lat = parseFloat(bus.gpsY);
      const lng = parseFloat(bus.gpsX);
      const carNo = bus.vehId;

      if (!isNaN(lat) && !isNaN(lng)) {
        const marker = new naver.maps.Marker({
          position: new naver.maps.LatLng(lat, lng),
          map: map,
          title: `버스 번호: ${carNo}`,
          icon: {
            url: '/image/bus/icon-bus.png',
            size: new naver.maps.Size(24, 24),
            origin: new naver.maps.Point(0, 0),
            anchor: new naver.maps.Point(8, 24)
          }
        });

        naver.maps.Event.addListener(marker, 'click', () => {
          info.open(map, marker);
        });

        busMarkers.push(marker);
      }
    });
  } catch (err) {
    clearBusMarkers();
    alert('버스 위치를 불러오는 중 오류가 발생했습니다: ' + err.message);
  }
}

function startBusTracking({ routeId, routeNumber }) {
  if (busTimer) {
    clearInterval(busTimer);
  }

  showBusPositions({ routeId, routeNumber });

  busTimer = setInterval(() => {
    showBusPositions({ routeId, routeNumber });
  }, 10000);
}

function stopBusTracking() {
  if (busTimer) {
    clearInterval(busTimer);
    busTimer = null;
    clearBusMarkers();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const btn = document.getElementById('sidebarBusBtn');
  const resetBtn = document.getElementById("resetMapBtn");
  const selector = document.getElementById("regionSelector");

  // ▶ 사이드바 버튼 초기화
  btn?.addEventListener('click', () => {
    stopBusTracking();
    clearStopMarkers();
    clearRouteDisplay();
    currentRouteId = null;
    routeStops = [];

    // ✅ 선택 전에는 allStops 초기화 (정류소 미표시)
    allStops = [];
  });

  // ▶ 초기화 버튼
  resetBtn?.addEventListener("click", () => {
    stopBusTracking();         // 실시간 추적 중지
    clearStopMarkers();        // 정류소 마커 제거
    clearRouteDisplay();       // 노선 경로 및 마커 제거
    clearBusMarkers();         // 버스 마커 제거

    currentRouteId = null;
    routeStops = [];
    allStops = [];

    // 1. 시/도 선택 초기화
    const selector = document.getElementById("regionSelector");
    if (selector) {
      selector.value = "";
    }

    // 2. 버스 번호 입력 초기화
    const input = document.getElementById("routeInput");
    if (input) {
      input.value = "";
    }

    // 3. 도착 정보 패널 초기화
    const arrivalPanel = document.getElementById("arrivalPanelBody");
    if (arrivalPanel) {
      arrivalPanel.innerHTML = `
      <div class="text-muted small py-3 px-2 text-center">
        ※ 시/도를 선택하거나 버스 번호로 검색하세요.
      </div>
    `;
    }

    // 4. 상세정보 팝업 닫기
    const popup = document.getElementById("routeDetailPopup");
    if (popup) {
      popup.classList.add("d-none");
    }

    // 5. 모달 닫기 (노선 목록 모달)
    const routeModal = bootstrap.Modal.getInstance(document.getElementById('routeListModal'));
    if (routeModal) {
      routeModal.hide();
    }

    // 6. 지도 중심을 기본 위치로 이동 (서울 기준)
    const center = cityCenters["서울특별시"];
    if (center && map) {
      map.setCenter(new naver.maps.LatLng(center[0], center[1]));
      map.setZoom(13); // 기본 줌 레벨
    }
  });

  // ▶ 시/도 선택 박스 로딩 및 이벤트
  try {
    const res = await fetch("/api/proxy/bus/regions");
    const cities = await res.json();

    cities.forEach(city => {
      const opt = document.createElement("option");
      opt.value = city;
      opt.textContent = city;
      selector?.appendChild(opt);
    });

    selector?.addEventListener("change", async e => {
      const region = e.target.value;

      stopBusTracking();
      clearStopMarkers();
      clearRouteDisplay();
      currentRouteId = null;
      routeStops = [];

      // ✅ 정류소 표시 전 전체 제거
      allStops = [];

      if (!region) return;

      if (region === '서울특별시') {
        await loadBusStopsByRegion(region); // 정류소 로딩 + 마커 표시 포함
      } else {
        alert(`[${region}] 지역의 정류소 정보는 준비 중입니다.`);
      }
    });

  } catch (e) {
    console.error("도시 목록 로딩 실패", e);
  }

  // ▶ 지도 이동 시 바운드 내 정류소 마커 갱신
  let idleTimer = null;
  naver.maps.Event.addListener(map, 'idle', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (map.getZoom() < 12) {
        clearStopMarkers();
        return;
      }

      // ✅ 경로 탐색 중이 아닐 때, 시/도 선택 후 정류소만 표시
      if (!currentRouteId && allStops.length > 0) {
        filterStopsInView();
      }
    }, 300);
  });
});

const cityCenters = {
  '서울특별시': [37.5665, 126.9780],
  '부산광역시': [35.1796, 129.0756],
  '대구광역시': [35.8714, 128.6014],
  '인천광역시': [37.4563, 126.7052],
  '광주광역시': [35.1595, 126.8526],
  '대전광역시': [36.3504, 127.3845],
  '울산광역시': [35.5384, 129.3114],
  '세종특별자치시': [36.4800, 127.2891],
  '경기도': [37.4138, 127.5183],
  '강원특별자치도': [37.8228, 128.1555],
  '충청북도': [36.6357, 127.4917],
  '충청남도': [36.5184, 126.8000],
  '전라북도': [35.7167, 127.1444],
  '전라남도': [34.8161, 126.4630],
  '경상북도': [36.4919, 128.8889],
  '경상남도': [35.4606, 128.2132],
  '제주특별자치도': [33.4996, 126.5312]
};

function clearStopMarkers() {
  stopMarkers.forEach(m => m.setMap(null));
  stopMarkers = [];
}

const normalIcon = {
  url: "/image/bus/bus-stop.png",
  size: new naver.maps.Size(16, 16),
  anchor: new naver.maps.Point(8, 16)
};

const selectedIcon = {
  url: "/image/bus/bus-stop-click.png",
  size: new naver.maps.Size(32, 32),
  anchor: new naver.maps.Point(16, 32)
};

let lastSelectedStopMarker = null;

function drawStopMarkers(stops, isRouteMarkers = false) {
  if (!isRouteMarkers) clearStopMarkers();

  let index = 0;
  const batchSize = 200;
  const delay = 50;

  function drawBatch() {
    const nextBatch = stops.slice(index, index + batchSize);

    nextBatch.forEach(stop => {
      const lat = parseFloat(stop.lat || stop.latitude);
      const lng = parseFloat(stop.lng || stop.longitude);
      const name = stop.name || stop.stationName;

      const stopId = stop.stopId || stop.nodeId || stop.id;
      const arsId = stop.arsId || "01";

      if (!stopId) {
        console.warn("❗ 정류소 ID 누락됨", stop);
        return;
      }

      const icon = isRouteMarkers
        ? {
          url: "/image/bus/bus-stop-route.png",
          size: new naver.maps.Size(16, 16),
          anchor: new naver.maps.Point(8, 16)
        }
        : normalIcon;

      const marker = new naver.maps.Marker({
        position: new naver.maps.LatLng(lat, lng),
        map: map,
        title: name,
        icon: icon
      });

      naver.maps.Event.addListener(marker, 'click', () => {
        console.log("🧭 정류소 클릭:", stopId, arsId);

        // 🔁 이전 마커 원상복구
        if (lastSelectedStopMarker && !isRouteMarkers) {
          lastSelectedStopMarker.setIcon(normalIcon);
        }

        // 🎯 현재 마커 강조
        if (!isRouteMarkers) {
          marker.setIcon(selectedIcon);
          lastSelectedStopMarker = marker;
        }

        onBusStopClick(stopId, arsId, name);
      });

      if (isRouteMarkers) {
        window.routeMarkers.push(marker);
      } else {
        stopMarkers.push(marker);
      }
    });

    index += batchSize;
    if (index < stops.length) setTimeout(drawBatch, delay);
  }

  drawBatch();
}

let lastBounds = null;
const MAX_MARKERS = 500;

async function filterStopsInView() {
  if (!map) return;

  const bounds = map.getBounds();
  const sw = bounds.getSW();
  const ne = bounds.getNE();

  try {
    const res = await fetch(`/api/proxy/bus/stops/in-bounds?minLat=${sw.lat()}&maxLat=${ne.lat()}&minLng=${sw.lng()}&maxLng=${ne.lng()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      redirect: 'follow' // 또는 'manual'로 리디렉션 방지
    });

    // 🚨 로그인 페이지로 리다이렉션 되었다면, fetch는 응답 본문이 HTML임
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      alert("세션이 만료되었거나 로그인이 필요합니다. 다시 로그인해주세요.");
      location.href = "/login";
      return;
    }

    if (!res.ok) {
      throw new Error("서버 응답 오류: " + res.status);
    }

    const stops = await res.json();
    allStops = stops;
    drawStopMarkers(stops.slice(0, 1000));
  } catch (e) {
    console.error("정류소 로딩 실패", e);
    alert("정류소 정보를 불러오는 데 실패했습니다.");
  }
}

async function loadBusStopsByRegion(region) {
  if (!region) return;

  // ✅ 버스 패널이 꺼져있으면 실행 안 함
  if (!panelStates.bus) {
    console.warn("버스 패널이 비활성화 상태입니다. 정류소 로딩 중단.");
    return;
  }

  // ✅ 지도 중심 이동
  if (cityCenters[region]) {
    const [lat, lng] = cityCenters[region];
    map.setCenter(new naver.maps.LatLng(lat, lng));
    map.setZoom(16);
  }

  try {
    const res = await fetch(`/api/proxy/bus/stops?region=${encodeURIComponent(region)}`);

    if (!res.ok) {
      throw new Error(`정류소 불러오기 실패: ${res.status}`);
    }

    allStops = await res.json();

    // ✅ 버스 경로가 없는 상태에서만 마커 표시
    if (!currentRouteId && allStops.length > 0 && panelStates.bus) {
      drawStopMarkers(allStops.slice(0, MAX_MARKERS)); // 예: 1000
    }

  } catch (err) {
    console.error("정류소 불러오기 실패", err);
    alert("정류소 정보를 불러오는 중 문제가 발생했습니다.");
  }
}

function onBusStopClick(stopId, arsId = "01", stopName = "정류소") {
  fetch(`/api/proxy/bus/arrivals?stopId=${stopId}&arsId=${arsId}`)
    .then(res => res.json())
    .then(arrivals => {
      showArrivalModal(arrivals, stopName); // ✅ 정류소명 전달
    });

  fetch(`/api/proxy/bus/routes?stopId=${stopId}`)
    .then(res => res.json())
    .then(routes => showRouteListModal(routes));
}

function showArrivalModal(arrivals, stopName = "정류소") {
  const container = document.getElementById("arrivalPanelBody");
  if (!container) return;

  // 기존 타이머 제거
  Object.values(arrivalTimers).forEach(clearInterval);
  arrivalTimers = {};

  const soon = [], running = [], waiting = [], turning = [], ended = [], unknown = [];

  const sorted = [...arrivals].sort((a, b) =>
    a.routeNumber.localeCompare(b.routeNumber, 'ko', { numeric: true })
  );

  sorted.forEach((item, idx) => {
    const routeNumber = item.routeNumber;
    const routeType = item.routeType || "기타";
    const typeClass = typeColorMap[routeType] || "bg-light text-dark";
    const congestionClass = getCongestionClass(item.congestion);

    let statusText = item.arrivalTime;
    let category = 'unknown';
    const sec = parseArrivalSeconds(item.arrivalTime);

    // 상태 분류
    if (statusText === "운행 종료") {
      category = "ended";
    } else if (statusText?.includes("회차")) {
      statusText = "회차 대기";
      category = "turning";
    } else if (statusText?.includes("대기")) {
      statusText = "운행 대기";
      category = "waiting";
    } else if (sec !== null && sec <= 60) {
      statusText = "곧 도착";
      category = "soon";
    } else if (sec !== null) {
      statusText = `⏱ ${formatArrivalSec(sec)}`;
      category = "running";
    }

    const html = `
      <div class="arrival-card border-bottom py-2 arrival-item" data-route="${routeNumber}" style="cursor: pointer;">
        <div class="d-flex justify-content-between align-items-center">
          <div class="d-flex align-items-center flex-grow-1">
            <div class="bus-number-box ${typeClass} text-white fw-bold text-center me-2"
                 style="min-width: 50px; height: 32px; line-height: 32px; border-radius: 4px;">
              ${routeNumber}
            </div>
            <div class="flex-grow-1">
              <div class="d-flex justify-content-between small">
                <div id="arrivalTime${idx}" class="${congestionClass}">
                  ${statusText}
                </div>
                <div class="${congestionClass}" style="min-width: 50px; text-align: right;">
                  ${item.congestion || '정보 없음'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    switch (category) {
      case 'soon': soon.push({ html, idx, sec }); break;
      case 'running': running.push({ html, idx, sec }); break;
      case 'waiting': waiting.push({ html, idx }); break;
      case 'turning': turning.push({ html, idx }); break;
      case 'ended': ended.push({ html, idx }); break;
      default: unknown.push({ html, idx }); break;
    }
  });

  // 렌더링
  container.innerHTML = `<h5 class="mb-3"><i class="bi bi-bus-front-fill me-1"></i>${stopName}</h5>`;

  if (soon.length > 0) {
    container.innerHTML += `<div class="text-danger fw-bold mb-2">🚨 곧 도착</div>`;
    container.innerHTML += soon.map(e => e.html).join('');
  }
  if (running.length > 0) {
    container.innerHTML += `<div class="text-success mt-3 mb-2">🟢 운행 중</div>`;
    container.innerHTML += running.map(e => e.html).join('');
  }
  if (waiting.length > 0 || turning.length > 0) {
    container.innerHTML += `<div class="text-warning mt-3 mb-2">⏳ 운행 대기</div>`;
    container.innerHTML += [...waiting, ...turning].map(e => e.html).join('');
  }
  if (ended.length > 0) {
    container.innerHTML += `<div class="text-danger mt-3 mb-2">⛔ 운행 종료</div>`;
    container.innerHTML += ended.map(e => e.html).join('');
  }

  // 타이머 실행
  [...soon, ...running].forEach(({ idx, sec }) => {
    if (sec == null) return;
    arrivalTimers[idx] = setInterval(() => {
      const el = document.getElementById(`arrivalTime${idx}`);
      if (!el) return;
      sec--;
      if (sec <= 0) {
        el.textContent = "도착";
        clearInterval(arrivalTimers[idx]);
      } else {
        el.textContent = `⏱ ${formatArrivalSec(sec)}`;
      }
    }, 1000);
  });
}

function formatArrivalSec(sec) {
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return `${min}분 ${remain}초`;
}

function makeHtml(idx, routeNumber, typeClass, statusText, congestionClass, item) {
  return `
    <div class="arrival-card border-bottom py-2 arrival-item" data-route="${routeNumber}">
      <div class="d-flex justify-content-between align-items-center">
        <div class="d-flex align-items-center flex-grow-1">
          <div class="bus-number-box ${typeClass} text-white fw-bold text-center me-2"
               style="min-width: 50px; height: 32px; line-height: 32px; border-radius: 4px;">
            ${routeNumber}
          </div>
          <div class="flex-grow-1">
            <div class="d-flex justify-content-between small">
              <div id="arrivalTime${idx}" class="${congestionClass}">
                ${statusText}
              </div>
              <div class="${congestionClass}" style="min-width: 50px; text-align: right;">
                ${item.congestion || '정보 없음'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function getCongestionClass(text) {
  if (text === "여유") return "text-success";
  if (text === "보통") return "text-warning";
  if (text === "혼잡") return "text-danger";
  return "text-muted";
}

// 🔧 이벤트 위임으로 상세 표시
document.body.addEventListener('click', e => {
  const target = e.target.closest('.arrival-item');
  if (target && target.dataset.route) {
    const route = target.dataset.route;
    loadRouteDetail(route, target); // 💡 상세정보 패널 띄우기
  }
});

function showRouteListModal(routes) {
  const container = document.getElementById("routeListModalBody");
  if (!container) return;

  if (!Array.isArray(routes) || routes.length === 0) {
    container.innerHTML = "<p>이 정류장을 경유하는 버스가 없습니다.</p>";
  } else {
    container.innerHTML = routes.map(route => `
      <div class="d-flex justify-content-between align-items-center border-bottom py-2">
        <div>
          <strong>${route.routeNumber}</strong>
          <span class="text-muted">(${route.routeType})</span>
        </div>
        <button class="btn btn-sm btn-primary" onclick="onRouteSelected('${route.routeId}')">실시간 위치</button>
      </div>
    `).join('');
  }

  const modal = new bootstrap.Modal(document.getElementById('routeListModal'));
  modal.show();
}

function onRouteSelected(routeId) {
  stopBusTracking();
  startBusTracking({ routeId });
  loadRouteDetail(null, routeId);  // ✅ routeId 직접 전달
}

function clearRouteDisplay() {
  if (window.routeLine) {
    window.routeLine.setMap(null);
    window.routeLine = null;
  }

  if (Array.isArray(window.routeMarkers)) {
    window.routeMarkers.forEach(marker => marker.setMap(null));
    window.routeMarkers = [];
  }

  // 🆕 내부 상태 초기화
  window.currentRouteId = null;
  window.routeStops = [];

  const arrivalPanel = document.getElementById("arrivalPanelBody");
  if (arrivalPanel) {
    arrivalPanel.innerHTML = `<div class="text-muted small py-3 px-2 text-center">
      ※ 시/도를 선택하거나 버스 번호로 검색하세요.
    </div>`;
  }
}

window.searchBusRoute = async function () {
  const input = document.getElementById("routeInput");
  const routeNumber = input?.value?.trim();

  if (!routeNumber) {
    alert("버스 번호를 입력해주세요.");
    return;
  }

  stopBusTracking();      // 실시간 추적 중지
  clearStopMarkers();     // 정류소 마커 제거
  clearRouteDisplay();    // 이전 경로 제거
  currentRouteId = null;

  try {
    const res = await fetch(`/api/proxy/bus/routes?routeNumber=${encodeURIComponent(routeNumber)}`);
    const stops = await res.json();

    if (stops.length === 0) {
      alert("해당 버스 노선 정보를 찾을 수 없습니다.");
      return;
    }

    // ✅ 1. 지도에 표시
    const path = stops.map(stop =>
      new naver.maps.LatLng(parseFloat(stop.lat), parseFloat(stop.lng))
    );

    if (window.routeLine) {
      window.routeLine.setMap(null);
    }
    window.routeLine = new naver.maps.Polyline({
      path: path,
      strokeColor: '#0078ff',
      strokeWeight: 4,
      map: map
    });

    // ✅ 2. 지도 위치를 경로 중앙으로 이동
    const bounds = new naver.maps.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    map.fitBounds(bounds); // 👈 경로가 전부 보이도록 줌 조정

    // ✅ 3. 정류소 마커 표시 (노선용, 지도용)
    drawStopMarkers(stops, true);       // 노선 마커
    // drawStopMarkers(visibleStops);   // ❌ 이거 호출하면 방금 표시한 마커 덮임!!

    // ✅ 4. 실시간 버스 위치 추적
    startBusTracking({ routeNumber });

    currentRouteId = routeNumber;
    routeStops = stops;

  } catch (err) {
    console.error("버스 경로 조회 실패", err);
    alert("버스 노선 정보를 불러오는 데 실패했습니다.");
  }
};

async function loadRouteDetail(routeNumber, triggerEl) {
  try {
    const res = await fetch(`/api/proxy/bus/detail?routeNumber=${routeNumber}`);

    // ✅ 404 등 비정상 응답 처리
    if (!res.ok) {
      const error = await res.json();
      alert(`버스 상세 정보 요청 실패: ${error?.error || res.statusText}`);
      return;
    }

    const data = await res.json();
    console.log("📦 상세정보 응답:", data);

    const html = `
      <div class="fw-bold mb-1">${data?.routeNumber || '알 수 없음'}번 버스</div>
      <div>🕒 배차: ${data?.interval || '정보 없음'}</div>
      <div>🚏 첫차: ${data?.firstTime || '정보 없음'}</div>
      <div>🌙 막차: ${data?.lastTime || '정보 없음'}</div>
      <div class="mt-2 text-end">
        <button class="btn btn-sm btn-outline-primary" onclick="openBusRoutePanel('${data?.routeNumber || ''}')">
          노선 보기
        </button>
      </div>
    `;

    const popup = document.getElementById('routeDetailPopup');
    const content = document.getElementById('routeDetailPopupContent');
    content.innerHTML = html;

    // 위치 고정
    const rect = triggerEl.getBoundingClientRect();
    popup.style.top = `${window.scrollY + 60}px`;
    popup.style.right = `20px`;

    popup.classList.remove('d-none');
  } catch (err) {
    console.error("상세 정보 불러오기 실패", err);
    alert("버스 상세 정보를 불러오는 중 오류 발생: " + err.message);
  }
}

async function loadArrivalAtStop(stopId, arsId) {
  try {
    const res = await fetch(`/api/proxy/bus/arrivals?stopId=${stopId}&arsId=${arsId}`);
    const arrivals = await res.json();

    const stopElem = [...document.querySelectorAll(`#busStopListContainer .border-bottom`)]
      .find(div => div.innerHTML.includes(stopId));
    if (!stopElem) return;

    const arrivalHtml = arrivals.map(arrival => `
      <div class="small text-primary mt-1">
        🚌 ${arrival.routeNumber} → ${arrival.arrivalTime} (${arrival.congestion})
      </div>
    `).join("");

    stopElem.insertAdjacentHTML('beforeend', arrivalHtml);
  } catch (e) {
    console.error("도착 정보 불러오기 오류", e);
    alert("도착 정보를 불러오는 중 오류 발생");
  }
}

document.body.addEventListener('click', e => {
  const target = e.target.closest('.arrival-item');
  if (target && target.dataset.route) {
    const route = target.dataset.route;
    stopBusTracking();
    startBusTracking({ routeNumber: route });  // ✅ 실시간 위치만 표시
  }
})

document.addEventListener("click", function (e) {
  const popup = document.getElementById("routeDetailPopup");
  if (!popup.contains(e.target) && !e.target.classList.contains("route-detail-btn")) {
    popup.classList.add("d-none");
  }
});

function parseArrivalSeconds(arrivalText) {
  if (!arrivalText) return null;
  const secOnly = arrivalText.match(/^(\d+)\s*초$/);
  if (secOnly) return parseInt(secOnly[1], 10);

  const full = arrivalText.match(/^(\d+)\s*분\s*(\d+)?\s*초?/);
  if (full) {
    const min = parseInt(full[1], 10);
    const sec = full[2] ? parseInt(full[2], 10) : 0;
    return min * 60 + sec;
  }

  const minOnly = arrivalText.match(/^(\d+)\s*분$/);
  if (minOnly) return parseInt(minOnly[1], 10) * 60;

  return null;
}

async function openBusRoutePanel(routeNumber) {
  if (!routeNumber) return;

  stopBusTracking();
  clearStopMarkers();
  clearRouteDisplay();
  currentRouteId = null;

  try {
    const res = await fetch(`/api/proxy/bus/routes?routeNumber=${encodeURIComponent(routeNumber)}`);
    const stops = await res.json();

    if (!Array.isArray(stops) || stops.length === 0) {
      alert("해당 노선의 정류소 정보를 찾을 수 없습니다.");
      return;
    }

    // 1️⃣ 노선 경로 폴리라인
    const path = stops.map(stop => new naver.maps.LatLng(parseFloat(stop.lat), parseFloat(stop.lng)));

    window.routeLine = new naver.maps.Polyline({
      path: path,
      strokeColor: '#0078ff',
      strokeWeight: 4,
      map: map
    });

    // 2️⃣ 경로 기준 지도 확대
    const bounds = new naver.maps.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    map.fitBounds(bounds);

    // 3️⃣ 노선 정류소 마커
    drawStopMarkers(stops, true);

    // 4️⃣ 실시간 버스 위치 추적 시작
    startBusTracking({ routeNumber });

    currentRouteId = routeNumber;
    routeStops = stops;

    // 5️⃣ 상세 정보 패널 닫기 (선택사항)
    document.getElementById("routeDetailPopup")?.classList.add("d-none");

  } catch (err) {
    console.error("노선 보기 실패", err);
    alert("노선 정보를 불러오는 중 오류가 발생했습니다.");
  }
}

// 전역 등록
window.loadRouteDetail = loadRouteDetail;
window.openBusRoutePanel = openBusRoutePanel;
window.loadArrivalAtStop = loadArrivalAtStop;
window.startBusTracking = startBusTracking;
window.stopBusTracking = stopBusTracking;
window.clearBusMarkers = clearBusMarkers;
window.showBusPositions = showBusPositions;
window.clearRouteDisplay = clearRouteDisplay;
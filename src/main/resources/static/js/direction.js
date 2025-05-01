let directionPolyline = null;
let directionInfoWindow = null;
let myLocationMarker = null;
let routeClickMarker = null;
let routeClickInfoWindow = null;
let routeActive = false;
let searchTimeout = null;
let startMarker = null;
let goalMarker = null;
let mapClickListener = null;
let popupLocked = false;

// ✅ 출발지 / 도착지 전역 상태
window.routeStart = { lat: null, lng: null, label: "내 위치" };
window.routeGoal = { lat: null, lng: null, label: "" };

// ✅ 현재 위치를 출발지로 초기화
window.setStartToCurrentLocation = function () {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    routeStart = { lat, lng, label: "내 위치" };
    document.getElementById('startPointLabel').value = "내 위치";

    const position = new naver.maps.LatLng(lat, lng);

    if (myLocationMarker) myLocationMarker.setMap(null);

    myLocationMarker = new naver.maps.Marker({
      position,
      map,
      icon: {
        url: '/image/my-marker.png',  // ✅ 네가 만든 내 위치 이미지 경로
        size: new naver.maps.Size(44, 66),    // ✅ 이미지 크기
        anchor: new naver.maps.Point(22, 22)  // ✅ 중심을 이미지 정중앙으로 설정
      },
      title: "내 위치",
      zIndex: 999
    });

    map.panTo(position);
  });
};

// ✅ 경로 클릭 이벤트
window.initRouteEvents = function () {
  if (mapClickListener) return; // 이미 등록됐으면 무시

  mapClickListener = naver.maps.Event.addListener(window.map, 'click', function (e) {
    if (popupLocked) return; // ✅ 막아주는 부분

    const lat = e.coord.lat();
    const lng = e.coord.lng();
    showRouteChoice(lat, lng, "선택한 위치");
  });
};

// ✅ 이벤트 제거 함수도 추가
window.removeRouteEvents = function () {
  if (mapClickListener) {
    naver.maps.Event.removeListener(mapClickListener);
    mapClickListener = null;
  }
};

// ✅ 출/도 마커 선택 팝업
window.showRouteChoice = function (lat, lng, label) {
  // ✅ 기존 popup이 있을 경우 제거
  if (window.routeClickInfoWindow) {
    window.routeClickInfoWindow.setMap(null);
    window.routeClickInfoWindow = null;
  }
  if (routeClickMarker) {
    routeClickMarker.setMap(null);
    routeClickMarker = null;
  }

  const position = new naver.maps.LatLng(lat, lng);
  routeClickMarker = new naver.maps.Marker({ position, map });

  const content = document.createElement('div');
  content.className = 'clean-popup';
  content.innerHTML = `
    <div class="popup-title">${label}</div>
    <div class="popup-btn" onclick="setAsStart(${lat}, ${lng}, '${label}')">
      <i class="bi bi-flag-fill text-success"></i> 출발지로 설정
    </div>
    <div class="popup-btn" onclick="setAsGoal(${lat}, ${lng}, '${label}')">
      <i class="bi bi-geo-alt-fill text-primary"></i> 도착지로 설정
    </div>
  `;

  const overlay = new naver.maps.OverlayView();
  overlay.onAdd = function () {
    this.getPanes().overlayLayer.appendChild(content);
  };
  overlay.draw = function () {
    const proj = this.getProjection();
    const point = proj.fromCoordToOffset(position);
    content.style.left = (point.x - content.offsetWidth / 2) + 'px';
    content.style.top = (point.y - content.offsetHeight - 20) + 'px'; // 마커 위로 띄움    
  };
  overlay.onRemove = function () {
    if (content.parentNode) content.parentNode.removeChild(content);
  };

  overlay.setMap(map);
  window.routeClickInfoWindow = overlay;
};

// ✅ 경로 탐색
window.findDirection = function (startLat, startLng, goalLat, goalLng) {
  const url = `/api/proxy/naver-direction?startLat=${startLat}&startLng=${startLng}&goalLat=${goalLat}&goalLng=${goalLng}`;

  fetch(url)
    .then(res => res.json())
    .then(data => {
      const route = data?.route?.trafast?.[0];
      if (!route?.path) return alert("경로를 찾을 수 없습니다.");

      const path = route.path.map(([lng, lat]) => new naver.maps.LatLng(lat, lng));

      if (directionPolyline) directionPolyline.setMap(null);
      if (directionInfoWindow) directionInfoWindow.close();

      directionPolyline = new naver.maps.Polyline({
        path,
        map,
        strokeColor: '#0d6efd',
        strokeWeight: 6,
        strokeOpacity: 0.9
      });

      const mid = path[Math.floor(path.length / 2)];
      const durationMin = Math.round(route.summary.duration / 60000);

      directionInfoWindow = new naver.maps.InfoWindow({
        content: `<div style="padding:6px 12px;">🕒 예상 소요: <strong>${durationMin}분</strong></div>`,
        position: mid
      });

      directionInfoWindow.open(map);
      map.panTo(mid);
    })
    .catch(err => {
      console.error("❌ 경로 API 실패:", err);
      alert("경로를 가져올 수 없습니다.");
    });
};

// ✅ 출/도 설정
window.setAsStart = function (lat, lng, label) {
  if (routeStart.lat === lat && routeStart.lng === lng) {
    routeClickInfoWindow?.setMap(null);
    return;
  }

  popupLocked = true; // ✅ popup 자동 호출 방지

  startMarker?.setMap(null);
  routeClickMarker?.setMap(null);

  routeStart = { lat, lng, label };
  document.getElementById('startPointLabel').value = label;

  startMarker = new naver.maps.Marker({
    position: new naver.maps.LatLng(lat, lng),
    map,
    icon: {
      content: `<div style="font-size: 32px;">🚩</div>`,
      anchor: new naver.maps.Point(16, 32)
    },
    title: "출발지"
  });

  routeClickInfoWindow?.setMap(null);

  tryFindRoute();

  // 300ms 후 popup 다시 열리게 허용
  setTimeout(() => {
    popupLocked = false;
  }, 300);
};


window.setAsGoal = function (lat, lng, label) {
  if (routeGoal.lat === lat && routeGoal.lng === lng) {
    window.routeClickInfoWindow?.setMap(null);
    return;
  }

  popupLocked = true; // ✅ 팝업 락 설정

  if (goalMarker) goalMarker.setMap(null);

  routeGoal = { lat, lng, label };
  document.getElementById('goalPointLabel').value = label;

  goalMarker = new naver.maps.Marker({
    position: new naver.maps.LatLng(lat, lng),
    map,
    icon: {
      content: `<div style="font-size: 32px;">🎯</div>`,
      anchor: new naver.maps.Point(16, 32)
    },
    title: "도착지"
  });

  window.routeClickInfoWindow?.setMap(null);

  if (!routeStart.lat || !routeStart.lng) {
    window.setStartToCurrentLocation(); // fallback
  }

  tryFindRoute();

  // 일정 시간 후 락 해제
  setTimeout(() => popupLocked = false, 300);
};

// ✅ 경로 탐색 실행
function tryFindRoute() {
  if (routeStart.lat && routeGoal.lat) {
    findDirection(routeStart.lat, routeStart.lng, routeGoal.lat, routeGoal.lng);
    routeActive = true;
  }
}

// ✅ 경로 및 마커 초기화
window.clearRoute = function () {
  if (directionPolyline) directionPolyline.setMap(null);
  if (directionInfoWindow) directionInfoWindow.close();

  routeGoal = { lat: null, lng: null, label: "" };
  routeActive = false;
};

window.clearRouteMarkers = function () {
  if (startMarker) startMarker.setMap(null), startMarker = null;
  if (goalMarker) goalMarker.setMap(null), goalMarker = null;
  if (routeClickMarker) routeClickMarker.setMap(null), routeClickMarker = null;

  // ✅ 순서 중요! null로 바꾸기 전에 setMap(null) 호출
  if (routeClickInfoWindow) {
    routeClickInfoWindow.setMap(null);
    routeClickInfoWindow = null;
  }
};

window.resetRoutePanel = function () {
  // ✅ Overlay 제거
  if (routeClickInfoWindow) {
    routeClickInfoWindow.setMap(null);
    routeClickInfoWindow = null;
  }

  // ✅ 팝업 DOM도 확실히 제거
  document.querySelectorAll('.clean-popup').forEach(el => el.remove());

  // ✅ 마커 제거
  if (startMarker) startMarker.setMap(null), startMarker = null;
  if (goalMarker) goalMarker.setMap(null), goalMarker = null;
  if (routeClickMarker) routeClickMarker.setMap(null), routeClickMarker = null;

  // ✅ 경로 제거
  if (directionPolyline) directionPolyline.setMap(null), directionPolyline = null;
  if (directionInfoWindow) directionInfoWindow.close(), directionInfoWindow = null;

  // ✅ 상태 초기화
  window.routeStart = { lat: null, lng: null, label: "내 위치" };
  window.routeGoal = { lat: null, lng: null, label: "" };
  routeActive = false;

  // ✅ 클릭 이벤트 제거
  if (mapClickListener) {
    naver.maps.Event.removeListener(mapClickListener);
    mapClickListener = null;
  }

  // ✅ 입력창 초기화
  document.getElementById('startPointLabel').value = '';
  document.getElementById('goalPointLabel').value = '';
  document.getElementById('startResultList').innerHTML = '';
  document.getElementById('goalResultList').innerHTML = '';
  document.getElementById('startResultList').style.display = 'none';
  document.getElementById('goalResultList').style.display = 'none';

  // ✅ 다시 현재 위치로
  window.setStartToCurrentLocation();

  // ✅ 클릭 이벤트 다시 연결
  window.initRouteEvents();
};

// ✅ 자동완성
function setupAutoComplete(inputId, resultListId, isStart) {
  const input = document.getElementById(inputId);
  const resultList = document.getElementById(resultListId);

  input.addEventListener('input', function () {
    const keyword = this.value.trim();

    clearTimeout(searchTimeout);
    if (!keyword) {
      resultList.style.display = 'none';
      resultList.innerHTML = '';
      return;
    }

    searchTimeout = setTimeout(() => {
      fetch(`/api/proxy/kakao-place?query=${encodeURIComponent(keyword)}`)
        .then(res => res.json())
        .then(data => {
          const places = data.documents;
          resultList.innerHTML = '';

          if (!places.length) {
            resultList.style.display = 'none';
            return;
          }

          places.forEach(place => {
            const li = document.createElement('li');
            li.className = 'list-group-item list-group-item-action';
            li.textContent = place.place_name;

            li.addEventListener('click', () => {
              const lat = parseFloat(place.y);
              const lng = parseFloat(place.x);
              const label = place.place_name;

              input.value = label;
              resultList.innerHTML = '';
              resultList.style.display = 'none';

              map.panTo(new naver.maps.LatLng(lat, lng));
              isStart ? setAsStart(lat, lng, label) : setAsGoal(lat, lng, label);
            });

            resultList.appendChild(li);
          });

          resultList.style.display = 'block';
        });
    }, 300);
  });
}

// ✅ 자동완성 바인딩
document.addEventListener("DOMContentLoaded", () => {
  setupAutoComplete('startPointLabel', 'startResultList', true);
  setupAutoComplete('goalPointLabel', 'goalResultList', false);
});
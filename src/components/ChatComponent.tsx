'use client'
import { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';

interface PartnerFoundData {
  roomId: string;
  isInitiator: boolean;
}

// Use your Railway URL as the default.
const socket: Socket = io(
  process.env.NEXT_PUBLIC_BACKEND_URL ||
    'https://audio-omegle-server-production.up.railway.app/'
);

const ChatComponent: React.FC = () => {
  // Canvas refs for waveform visualization.
  const localCanvasRef = useRef<HTMLCanvasElement>(null);
  const remoteCanvasRef = useRef<HTMLCanvasElement>(null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Idle');
  const [error, setError] = useState<string | null>(null);
  const [autoSearch, setAutoSearch] = useState<boolean>(true);
  const [socketConnected, setSocketConnected] = useState<boolean>(false);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localAudioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  // Function to draw waveform from an AnalyserNode to a canvas.
  const drawWaveform = (analyser: AnalyserNode, canvas: HTMLCanvasElement) => {
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const width = canvas.width;
    const height = canvas.height;

    const draw = () => {
      analyser.getByteTimeDomainData(dataArray);
      canvasCtx.fillStyle = '#222';
      canvasCtx.fillRect(0, 0, width, height);

      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = '#0f0';
      canvasCtx.beginPath();
      const sliceWidth = width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;
        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();
      requestAnimationFrame(draw);
    };
    draw();
  };

  useEffect(() => {
    // Monitor socket connection status.
    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));

    // Listen for partner found event.
    socket.on('partnerFound', async (data: PartnerFoundData) => {
      setRoomId(data.roomId);
      setStatus('Partner found, starting call...');
      await startCall(data.roomId, data.isInitiator);
    });

    socket.on('offer', async ({ offer }: { offer: RTCSessionDescriptionInit; }) => {
      if (!peerConnectionRef.current) await startCall(roomId, false);
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(offer);
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        socket.emit('answer', { roomId, answer });
      }
    });

    socket.on('answer', async ({ answer }: { answer: RTCSessionDescriptionInit; }) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(answer);
      }
    });

    socket.on('ice-candidate', async ({ candidate }: { candidate: RTCIceCandidateInit; }) => {
      if (peerConnectionRef.current && candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(candidate);
        } catch (err) {
          console.error('Error adding candidate:', err);
        }
      }
    });

    // Handle hangup/disconnect events.
    socket.on('hangup', () => {
      setStatus('Partner hung up');
      cleanupCall();
    });

    socket.on('disconnect', () => {
      setStatus('Disconnected from server');
      cleanupCall();
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('partnerFound');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('hangup');
    };
  }, [roomId]);

  const startCall = async (room: string | null, isInitiator: boolean) => {
    if (!room) return;
    try {
      // Create RTCPeerConnection.
      peerConnectionRef.current = new RTCPeerConnection(rtcConfig);
      setStatus('Initializing call...');

      peerConnectionRef.current.onconnectionstatechange = () => {
        const state = peerConnectionRef.current?.connectionState;
        console.log('Connection state changed:', state);
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          cleanupCall();
        }
      };

      // Request audio-only stream.
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localStreamRef.current = stream;

      // Set up local audio context and analyser.
      localAudioContextRef.current = new AudioContext();
      const localSource = localAudioContextRef.current.createMediaStreamSource(stream);
      localAnalyserRef.current = localAudioContextRef.current.createAnalyser();
      localAnalyserRef.current.fftSize = 2048;
      // Create a silent gain node so you do not hear your own audio.
      const silentGain = localAudioContextRef.current.createGain();
      silentGain.gain.value = 0;
      localSource.connect(localAnalyserRef.current);
      localAnalyserRef.current.connect(silentGain);
      silentGain.connect(localAudioContextRef.current.destination);
      if (localCanvasRef.current && localAnalyserRef.current) {
        drawWaveform(localAnalyserRef.current, localCanvasRef.current);
      }

      // Add local audio tracks to peer connection.
      stream.getTracks().forEach((track) => {
        peerConnectionRef.current?.addTrack(track, stream);
      });

      // When remote tracks are received.
      peerConnectionRef.current.ontrack = (event: RTCTrackEvent) => {
        const [remoteStream] = event.streams;
        // Set up remote audio context and analyser only once.
        if (!remoteAudioContextRef.current) {
          remoteAudioContextRef.current = new AudioContext();
          // Ensure the context is running (sometimes needs a user gesture).
          remoteAudioContextRef.current.resume();
          remoteAnalyserRef.current = remoteAudioContextRef.current.createAnalyser();
          remoteAnalyserRef.current.fftSize = 2048;
          const remoteSource = remoteAudioContextRef.current.createMediaStreamSource(remoteStream);
          // Connect remote audio so you can hear it.
          remoteSource.connect(remoteAnalyserRef.current);
          remoteAnalyserRef.current.connect(remoteAudioContextRef.current.destination);
          if (remoteCanvasRef.current && remoteAnalyserRef.current) {
            drawWaveform(remoteAnalyserRef.current, remoteCanvasRef.current);
          }
        }
      };

      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { roomId: room, candidate: event.candidate });
        }
      };

      if (isInitiator) {
        const offer = await peerConnectionRef.current.createOffer();
        await peerConnectionRef.current.setLocalDescription(offer);
        socket.emit('offer', { roomId: room, offer });
      }
    } catch (err: any) {
      console.error('Error starting call:', err);
      setError(`Error starting call: ${err.message}`);
      setStatus('Error');
    }
  };

  const cleanupCall = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localAudioContextRef.current) {
      localAudioContextRef.current.close();
      localAudioContextRef.current = null;
    }
    if (remoteAudioContextRef.current) {
      remoteAudioContextRef.current.close();
      remoteAudioContextRef.current = null;
    }
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    setRoomId(null);
    setStatus('Idle');
    if (autoSearch) {
      setStatus('Searching for a partner...');
      setTimeout(() => {
        socket.emit('findPartner');
      }, 500);
    }
  };

  const handleButtonClick = () => {
    if (roomId) {
      socket.emit('hangup', { roomId });
      cleanupCall();
    } else {
      setStatus('Searching for a partner...');
      socket.emit('findPartner');
    }
  };

  const toggleAutoSearch = () => {
    setAutoSearch(!autoSearch);
  };

  return (
    <div className="bg-gray-900 text-white rounded-lg shadow-lg p-6 max-w-2xl mx-auto my-8">
      <h1 className="text-3xl font-bold mb-4 text-center">Audio Omegle Clone Chat</h1>
      <p className="text-lg mb-4 text-center">
        Status: <span className="font-semibold">{status}</span>
      </p>
      <p className="text-sm text-center mb-4">
        Socket: {socketConnected ? 'Connected' : 'Disconnected'}
      </p>
      {error && <p className="text-red-500 mb-4 text-center">{error}</p>}

      <div className="flex justify-center mb-4">
        <button
          onClick={handleButtonClick}
          className={`${
            roomId ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
          } text-white font-semibold py-2 px-6 rounded`}
        >
          {roomId ? 'Next' : 'Search'}
        </button>
      </div>

      <div className="text-center mb-4">
        <button onClick={toggleAutoSearch} className="text-sm text-gray-300 underline">
          {autoSearch ? 'Stop Auto Search' : 'Enable Auto Search'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h2 className="text-xl font-medium mb-2 text-center">Local Audio Waveform</h2>
          <canvas
            ref={localCanvasRef}
            width={300}
            height={100}
            className="w-full rounded border border-gray-700 bg-black"
          />
        </div>
        <div>
          <h2 className="text-xl font-medium mb-2 text-center">Remote Audio Waveform</h2>
          <canvas
            ref={remoteCanvasRef}
            width={300}
            height={100}
            className="w-full rounded border border-gray-700 bg-black"
          />
        </div>
      </div>
    </div>
  );
};

export default ChatComponent;
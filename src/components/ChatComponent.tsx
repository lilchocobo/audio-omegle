'use client'
import { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';

interface PartnerFoundData {
  roomId: string;
  isInitiator: boolean;
}

const socket: Socket = io(process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001');

const ChatComponent: React.FC = () => {
  // Remove video refs; use canvas refs for waveform drawing.
  const localCanvasRef = useRef<HTMLCanvasElement>(null);
  const remoteCanvasRef = useRef<HTMLCanvasElement>(null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Idle');
  const [error, setError] = useState<string | null>(null);
  const [autoSearch, setAutoSearch] = useState<boolean>(true);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  
  // We also keep a ref for the local media stream (so that we can visualize it)
  const localStreamRef = useRef<MediaStream | null>(null);

  const rtcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };

  // Helper: visualize an audio stream on a given canvas.
  const visualizeAudio = (stream: MediaStream, canvas: HTMLCanvasElement) => {
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;
    
    const draw = () => {
      requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      canvasCtx.fillStyle = '#1f2937'; // Tailwind gray-800
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = '#3b82f6'; // Tailwind blue-500
      canvasCtx.beginPath();
      const sliceWidth = canvas.width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    };
    draw();
  };

  useEffect(() => {
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

    socket.on('hangup', () => {
      setStatus('Partner hung up');
      cleanupCall();
    });

    socket.on('disconnect', () => {
      setStatus('Disconnected from server');
      cleanupCall();
    });

    return () => {
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
      peerConnectionRef.current = new RTCPeerConnection(rtcConfig);
      setStatus('Initializing call...');

      // Set a connection timeout (10 seconds) in case nothing connects.
      const connectionTimeout = setTimeout(() => {
        if (peerConnectionRef.current?.connectionState !== 'connected') {
          console.warn('Connection timeout. Cleaning up call.');
          cleanupCall();
        }
      }, 10000);

      peerConnectionRef.current.onconnectionstatechange = () => {
        const state = peerConnectionRef.current?.connectionState;
        console.log('Connection state changed:', state);
        if (state === 'connected') {
          clearTimeout(connectionTimeout);
        }
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          cleanupCall();
        }
      };

      // Obtain audio-only media.
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localStreamRef.current = stream;
      
      // Once we get the local stream, start visualizing it.
      if (localCanvasRef.current) {
        visualizeAudio(stream, localCanvasRef.current);
      }
      stream.getTracks().forEach((track) => {
        peerConnectionRef.current?.addTrack(track, stream);
      });

      // When remote audio is received, visualize it on the remote canvas.
      peerConnectionRef.current.ontrack = (event: RTCTrackEvent) => {
        const [remoteStream] = event.streams;
        if (remoteCanvasRef.current) {
          visualizeAudio(remoteStream, remoteCanvasRef.current);
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

  // Cleanup: stop local media tracks, close the peer connection, and auto-search if enabled.
  const cleanupCall = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
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

  // When the user clicks the button.
  // If in a call, emit "hangup"; otherwise, request media permissions and start searching.
  const handleButtonClick = async () => {
    if (roomId) {
      socket.emit('hangup', { roomId });
      cleanupCall();
    } else {
      setStatus('Requesting audio permissions...');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        localStreamRef.current = stream;
        if (localCanvasRef.current) {
          visualizeAudio(stream, localCanvasRef.current);
        }
        setStatus('Audio access granted. Searching for a partner...');
        socket.emit('findPartner');
      } catch (err: any) {
        console.error('Error obtaining audio:', err);
        setError(`Audio permission error: ${err.message}`);
        setStatus('Idle');
      }
    }
  };

  const toggleAutoSearch = () => {
    setAutoSearch(!autoSearch);
  };

  return (
    <div className="bg-gray-900 text-white rounded-lg shadow-xl p-8 max-w-2xl mx-auto my-10">
      <h1 className="text-4xl font-bold mb-6 text-center">Omegle Audio Chat</h1>
      <p className="text-xl mb-6 text-center">
        Status: <span className="font-semibold">{status}</span>
      </p>
      {error && <p className="text-red-500 mb-4 text-center">{error}</p>}
      
      <div className="flex justify-center mb-6">
        <button
          onClick={handleButtonClick}
          className={`px-8 py-3 rounded-full font-bold transition duration-200 ${
            roomId ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
          }`}
        >
          {roomId ? 'Next' : 'Search'}
        </button>
      </div>
      
      <div className="text-center mb-6">
        <button onClick={toggleAutoSearch} className="text-sm text-gray-300 underline">
          {autoSearch ? 'Stop Auto Search' : 'Enable Auto Search'}
        </button>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h2 className="text-2xl font-medium mb-4 text-center">Local Audio Waveform</h2>
          <canvas ref={localCanvasRef} className="w-full h-32 rounded-lg border-2 border-gray-700" />
        </div>
        <div>
          <h2 className="text-2xl font-medium mb-4 text-center">Remote Audio Waveform</h2>
          <canvas ref={remoteCanvasRef} className="w-full h-32 rounded-lg border-2 border-gray-700" />
        </div>
      </div>
    </div>
  );
};

export default ChatComponent;
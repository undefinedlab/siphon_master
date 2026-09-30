// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 withdraw6 zkey sha256=0e1ecc91f2227b608873d1064287202c5fa27d1b62e6e35fcf4a639ec4deeea1
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendWithdrawVerifier6 {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 7205485612608884431791921750744049568879382301403616656908078679325085958449;
    uint256 constant IC0y = 1398051812687908905452495316693693502691574719420955327359455050296764846155;

    uint256 constant IC1x = 21246933771490186039888036631733353156225626858021482559147168605232890794309;
    uint256 constant IC1y = 15515712554749680628572131609989935133640534239918424338462951074005914870966;

    uint256 constant IC2x = 14436506505430412181306057400937729235886292296855524462247404958447880357637;
    uint256 constant IC2y = 13315450336006559369807260959635210078080135608676283437346282645099706474943;

    uint256 constant IC3x = 3681135998765010768636914704528982006984669545470297893209473501572342268209;
    uint256 constant IC3y = 9019865662045605458042848946143259567236809508103291412251927461703583131630;

    uint256 constant IC4x = 9254854103046924551471773628028731702021638538869477204094934716129973158758;
    uint256 constant IC4y = 14905306068500708075418497227537673460625449275201670053241464856513397555453;

    uint256 constant IC5x = 5385042269790165572828891967132639615844874411640092414412128507691431246446;
    uint256 constant IC5y = 8840447469731760663668395541391045795993358181119689688643141584596315333028;

    uint256 constant IC6x = 19103348896127849818284399818034160052713052804441835764435028644100586769344;
    uint256 constant IC6y = 2849240561686309995646839994460720154546874865959375726861334272074103879400;

    uint256 constant IC7x = 5213764865769603624708125732426012603924038303476583656274327060932831090523;
    uint256 constant IC7y = 5409707553972723227298233535752322255201899021985010178545754135801710841148;

    uint256 constant IC8x = 7261384783856462037039645814076569301789945077004263068156024098237435616958;
    uint256 constant IC8y = 10882100844440678662216653194877406256770657353408905433070921549218597585699;

    uint256 constant IC9x = 5299753335579861722752613995245473806327768670033764790253321194819609276527;
    uint256 constant IC9y = 21351385202164580668201861533298948048257363521583540235592335934472483438100;

    uint256 constant IC10x = 5355982337101521799748375516339042050494333452753150827177614030479348094650;
    uint256 constant IC10y = 17083927193146494065245823745110545532076541035036799821585273270351717810929;

    uint256 constant IC11x = 15962562141864870561198673886232483306913427257397768960182690568923329018765;
    uint256 constant IC11y = 10458580899512656007517139997928555026704531836862948180793487566568637493222;

    uint256 constant IC12x = 10595345831185743053590284518802941928532283747877216716784245989531549679470;
    uint256 constant IC12y = 18663300579878659817176236646164759587179634641093544610305582539633411197844;

    uint256 constant IC13x = 7214240984551821073442964619006261051697649448436618890149130053156887337770;
    uint256 constant IC13y = 2222875510933575834662821679100389480882532053402798148242153779932625193880;

    uint256 constant IC14x = 16766045938328357605511670044274167219628030980614316925233958849208531783116;
    uint256 constant IC14y = 18016326189267963858325891836551620039423106619859036069007744747374617186099;

    uint256 constant IC15x = 10367476100418608195145316127847391925128303896198817319065543282275382250121;
    uint256 constant IC15y = 14280805298558274975109248599463499074666947688469652396188729069177816675422;

    uint256 constant IC16x = 1391605559076779962475701295842607662145300241101975334415890339232083824002;
    uint256 constant IC16y = 19847381117088671337468126926266104872899680188206937901698187685663509094321;

    uint256 constant IC17x = 4930974853148987496746176151440360236181403376184525856879071399954229385555;
    uint256 constant IC17y = 20398761984684987385914939625710532842927828273334275873054971185498851588998;

    uint256 constant IC18x = 21047893459973281350983487778276708235154093290212101691223276934372650315845;
    uint256 constant IC18y = 11281148178061050893547879722254445581157497056173087198281963929482534884188;

    uint256 constant IC19x = 17936238367454295065740201734245538832554833594525065631773847363240782696278;
    uint256 constant IC19y = 5422922428712665493137227492477564639808492228789830865058066868642708578294;

    uint256 constant IC20x = 21029847366256799605994226874928314296851870518467370628298856652490801183681;
    uint256 constant IC20y = 10981217949232175831560108914767992119536468854357389092829611448876101097347;

    uint256 constant IC21x = 480726940361500151002067372900995200752056952767283038877381674995312362655;
    uint256 constant IC21y = 8430157046771256267531805832900389396645341140195712682263574378023615339615;

    uint256 constant IC22x = 12892382928830917435507976317160486005021998595404768506337062635423676440052;
    uint256 constant IC22y = 2387527918938406735422331955245907380557745028084135411392805698677367817758;

    uint256 constant IC23x = 15155349497355844433667203520991126489619538732945973421391296313935905864512;
    uint256 constant IC23y = 11339076796288714029133169535867669219470815309242501446392149345968993277252;

    uint256 constant IC24x = 11201398738739851677970536406324214838075113496269230716617593960713105047931;
    uint256 constant IC24y = 6476840761256319637561884220301703211581717626193432785505189233492312396936;

    uint256 constant IC25x = 13111310823819715171988451518418285581620893583984578818488653696248574778014;
    uint256 constant IC25y = 8820635511495128275889730105358880540758598405502863755875106389144397243958;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
